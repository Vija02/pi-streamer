/**
 * jack_capture recording functionality
 *
 * Uses jack_capture instead of FFmpeg because FFmpeg JACK input
 * only supports up to 8 channels, while XR18 has 18 channels.
 *
 * GAPLESS RECORDING:
 * Uses jack_capture's built-in --rotatefile option for gapless segment rotation.
 * A single continuous jack_capture process runs and automatically rotates
 * files at the specified interval. No gaps between segments.
 */
import { $, spawn, type Subprocess } from "bun"
import { join } from "path"
import { getConfig } from "./config"
import { recordingLogger as logger } from "./logger"
import { checkJackSetup, getSourcePorts, stopJackServer, setupLaptopRouting } from "./jack"
import { waitForQueueEmpty, getQueueLength } from "./upload"
import { startWatcher, stopWatcher } from "./watcher"

export interface RecorderState {
	isRunning: boolean
	sessionDir: string
	process: Subprocess<"ignore", "pipe", "pipe"> | null
}

let state: RecorderState = {
	isRunning: false,
	sessionDir: "",
	process: null,
}

/**
 * Check if the finish trigger file exists
 */
async function checkFinishTrigger(): Promise<boolean> {
	const config = getConfig()
	return await Bun.file(config.finishTriggerPath).exists()
}

/**
 * Remove the finish trigger file
 */
async function clearFinishTrigger(): Promise<void> {
	const config = getConfig()
	try {
		await $`rm -f ${config.finishTriggerPath}`.quiet()
	} catch {
		// Ignore errors
	}
}

/**
 * Stop the recording process
 */
export function stopRecording(): void {
	state.isRunning = false
	if (state.process) {
		// Send SIGINT to jack_capture for graceful shutdown
		state.process.kill("SIGINT")
	}
}

/**
 * Get the current recorder state
 */
export function getRecorderState(): RecorderState {
	return { ...state, process: null } // Don't expose the process object
}

/**
 * Build jack_capture command arguments for continuous recording with file rotation
 */
function buildJackCaptureArgs(sessionDir: string): string[] {
	const config = getConfig()
	const { channels, sampleRate, segmentDuration, jackPortPrefix } = config

	// Calculate rotation interval in audio frames
	const rotateFrames = segmentDuration * sampleRate

	// Filename prefix - jack_capture will add _001, _002, etc.
	const filenamePrefix = join(sessionDir, "jack_capture")

	const args = [
		"-f", "wav",           // Output format (WAV - will be compressed to FLAC after recording)
		"-b", "24",            // Bit depth
		"-Rf", String(rotateFrames), // Rotate file every N frames
		"-fn", filenamePrefix, // Filename prefix
		"--no-stdin",          // Don't read from stdin (prevents immediate exit)
	]

	// Add port arguments for each channel (0-indexed for XR18 AUX ports)
	for (let i = 0; i < channels; i++) {
		args.push("-p", `${jackPortPrefix}${i}`)
	}

	return args
}

/**
 * Main recording loop - runs until stopped
 */
export async function startRecording(): Promise<void> {
	const config = getConfig()

	logger.info({ sessionId: config.sessionId }, "Starting recording service")

	// Clear any existing finish trigger
	await clearFinishTrigger()

	// Check JACK setup
	const jackCheck = await checkJackSetup()
	if (!jackCheck.ok) {
		logger.fatal("JACK server is not running. Start JACK first.")
		process.exit(1)
	}

	// Verify source ports exist
	const sourcePorts = await getSourcePorts()
	if (sourcePorts.length < config.channels) {
		logger.warn(
			{
				found: sourcePorts.length,
				expected: config.channels,
				ports: sourcePorts,
			},
			"Found fewer source ports than configured channels",
		)
	}

	// Setup laptop audio routing if enabled
	const laptopRouting = await setupLaptopRouting()
	if (config.laptopRouteEnabled && !laptopRouting.ok) {
		logger.warn({ errors: laptopRouting.errors }, "Some laptop routing connections failed")
	}

	// Create session directory
	const sessionDir = join(config.recordingDir, config.sessionId)
	await $`mkdir -p ${sessionDir}`
	state.sessionDir = sessionDir

	logger.info(
		{
			channels: config.channels,
			sampleRate: config.sampleRate,
			segmentDuration: config.segmentDuration,
			rotateFrames: config.segmentDuration * config.sampleRate,
			recordingDir: sessionDir,
			uploadEnabled: config.uploadEnabled,
			streamUrl: config.uploadEnabled ? config.streamUrl : undefined,
			finishTrigger: config.finishTriggerPath,
			jackPortPrefix: config.jackPortPrefix,
		},
		"Configuration loaded",
	)

	// Start the file watcher before recording
	if (config.uploadEnabled) {
		startWatcher(sessionDir)
		logger.info("File watcher started")
	}

	// Build jack_capture arguments
	const args = buildJackCaptureArgs(sessionDir)
	logger.info({ command: `jack_capture ${args.join(" ")}` }, "Starting jack_capture")

	// Start jack_capture process
	state.process = spawn(["jack_capture", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	})
	state.isRunning = true

	logger.info(
		"Recording started (gapless mode with file rotation). Touch finish trigger file to stop gracefully.",
	)

	// Handle graceful shutdown
	const shutdown = () => {
		logger.info("Shutdown signal received")
		stopRecording()
	}

	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)

	// Monitor for finish trigger in background
	const triggerCheck = async () => {
		while (state.isRunning) {
			if (await checkFinishTrigger()) {
				logger.info("Finish trigger detected, stopping recording")
				await clearFinishTrigger()
				stopRecording()
				break
			}
			await Bun.sleep(1000)
		}
	}
	triggerCheck() // Start in background (don't await)

	// Wait for jack_capture to exit
	const exitCode = await state.process.exited

	if (exitCode !== 0 && state.isRunning) {
		// Unexpected exit
		const stderr = await new Response(state.process.stderr).text()
		logger.error({ exitCode, stderr: stderr.trim() }, "jack_capture exited unexpectedly")
	} else {
		logger.info({ exitCode }, "jack_capture stopped")
	}

	state.isRunning = false
	state.process = null

	// Give filesystem a moment to sync after jack_capture exits
	await Bun.sleep(500)

	// Stop the file watcher and process any remaining files
	if (config.uploadEnabled) {
		await stopWatcher()
		logger.info("File watcher stopped")
	}

	// Wait for upload queue to finish
	const pendingUploads = getQueueLength()
	if (pendingUploads > 0) {
		logger.info(
			{ pending: pendingUploads },
			"Waiting for pending uploads to complete",
		)
		await waitForQueueEmpty()
	}

	// Notify receiver that session is complete
	if (config.uploadEnabled) {
		await notifySessionComplete(config.sessionId, config.streamUrl)
	}

	// Stop JACK server if we auto-started it
	await stopJackServer()

	logger.info("Recording service finished")
}

/**
 * Notify the receiver that a session is complete
 */
async function notifySessionComplete(sessionId: string, streamUrl: string): Promise<void> {
	// Derive the session complete URL from the stream URL
	const baseUrl = streamUrl.replace(/\/stream$/, "")
	const completeUrl = `${baseUrl}/session/complete`

	logger.info({ sessionId, url: completeUrl }, "Notifying receiver of session completion")

	try {
		const response = await fetch(completeUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionId }),
		})

		if (response.ok) {
			const result = await response.json()
			logger.info({ result }, "Receiver acknowledged session completion")
		} else {
			logger.warn(
				{ status: response.status },
				"Failed to notify receiver of session completion"
			)
		}
	} catch (err) {
		logger.warn({ err }, "Could not notify receiver of session completion (receiver may be offline)")
	}
}
