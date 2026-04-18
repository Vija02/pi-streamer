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
import { getConfig, loadConfig, type Config } from "./config"
import { recordingLogger as logger } from "./logger"
import { checkJackSetup, getSourcePorts, stopJackServer, setupLaptopRouting } from "./jack"
import { waitForQueueEmpty, getQueueLength } from "./upload"
import { startWatcher, stopWatcher } from "./watcher"

export interface RecorderState {
	isRunning: boolean
	sessionId: string
	sessionDir: string
	process: Subprocess<"ignore", "pipe", "pipe"> | null
}

let state: RecorderState = {
	isRunning: false,
	sessionId: "",
	sessionDir: "",
	process: null,
}

// Promise that resolves when recording stops (for awaiting in scheduler)
let recordingStoppedPromise: Promise<void> | null = null;
let recordingStoppedResolve: (() => void) | null = null;

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
 * Check if currently recording
 */
export function isRecording(): boolean {
	return state.isRunning
}

/**
 * Stop the recording process (internal)
 */
function stopRecordingInternal(): void {
	if (!state.isRunning) return
	
	state.isRunning = false
	if (state.process) {
		// Send SIGINT to jack_capture for graceful shutdown
		state.process.kill("SIGINT")
	}
}

/**
 * Stop the recording process (public API for manual stop)
 */
export function stopRecording(): void {
	stopRecordingInternal()
}

/**
 * Get the current recorder state
 */
export function getRecorderState(): Omit<RecorderState, 'process'> {
	return { 
		isRunning: state.isRunning,
		sessionId: state.sessionId,
		sessionDir: state.sessionDir,
	}
}

/**
 * Build jack_capture command arguments for continuous recording with file rotation
 */
function buildJackCaptureArgs(sessionDir: string, config: Config): string[] {
	const { channels, sampleRate, segmentDuration, jackPortPrefix } = config

	// Calculate rotation interval in audio frames
	const rotateFrames = segmentDuration * sampleRate

	// Filename prefix - includes detected console name, jack_capture will add _001, _002, etc.
	const consoleName = config.detectedConsole || "capture"
	const filenamePrefix = join(sessionDir, `${consoleName}_capture`)

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

/**
 * Ensure JACK is set up and ready
 */
async function ensureJackReady(): Promise<boolean> {
	const config = getConfig()
	
	// Check JACK setup
	const jackCheck = await checkJackSetup()
	if (!jackCheck.ok) {
		logger.error("JACK server is not running. Start JACK first.")
		return false
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

	return true
}

/**
 * Start a recording session with a specific session ID
 * This is the core function used by both manual recording and the scheduler
 */
export async function startRecordingSession(sessionId: string): Promise<boolean> {
	if (state.isRunning) {
		logger.warn({ currentSession: state.sessionId }, "Recording already in progress")
		return false
	}

	const config = getConfig()

	logger.info({ sessionId }, "Starting recording session")

	// Ensure JACK is ready
	if (!(await ensureJackReady())) {
		return false
	}

	// Create session directory
	const sessionDir = join(config.recordingDir, sessionId)
	await $`mkdir -p ${sessionDir}`
	
	state.sessionId = sessionId
	state.sessionDir = sessionDir

	logger.info(
		{
			sessionId,
			channels: config.channels,
			sampleRate: config.sampleRate,
			segmentDuration: config.segmentDuration,
			rotateFrames: config.segmentDuration * config.sampleRate,
			recordingDir: sessionDir,
			uploadEnabled: config.uploadEnabled,
			streamUrl: config.uploadEnabled ? config.streamUrl : undefined,
			jackPortPrefix: config.jackPortPrefix,
		},
		"Session configuration",
	)

	// Start the file watcher before recording
	if (config.uploadEnabled) {
		startWatcher(sessionDir, sessionId)
		logger.info("File watcher started")
	}

	// Build jack_capture arguments
	const args = buildJackCaptureArgs(sessionDir, config)
	logger.info({ command: `jack_capture ${args.join(" ")}` }, "Starting jack_capture")

	// Create promise for tracking when recording stops
	recordingStoppedPromise = new Promise((resolve) => {
		recordingStoppedResolve = resolve
	})

	// Start jack_capture process
	state.process = spawn(["jack_capture", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	})
	state.isRunning = true

	logger.info({ sessionId }, "Recording started")

	// Handle process exit in background
	handleProcessExit(sessionId, config)

	return true
}

/**
 * Handle jack_capture process exit and cleanup
 */
async function handleProcessExit(sessionId: string, config: Config): Promise<void> {
	if (!state.process) return

	// Wait for jack_capture to exit
	const exitCode = await state.process.exited

	if (exitCode !== 0 && state.isRunning) {
		// Unexpected exit
		const stderr = await new Response(state.process.stderr).text()
		logger.error({ exitCode, stderr: stderr.trim() }, "jack_capture exited unexpectedly")
	} else {
		logger.info({ exitCode, sessionId }, "jack_capture stopped")
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
		await notifySessionComplete(sessionId, config.streamUrl)
	}

	logger.info({ sessionId }, "Recording session finished")

	// Resolve the stopped promise
	if (recordingStoppedResolve) {
		recordingStoppedResolve()
		recordingStoppedResolve = null
		recordingStoppedPromise = null
	}
}

/**
 * Stop the current recording session and wait for cleanup
 */
export async function stopRecordingSession(): Promise<void> {
	if (!state.isRunning) {
		logger.debug("No recording in progress to stop")
		return
	}

	const sessionId = state.sessionId
	logger.info({ sessionId }, "Stopping recording session")

	// Stop the recording
	stopRecordingInternal()

	// Wait for cleanup to complete
	if (recordingStoppedPromise) {
		await recordingStoppedPromise
	}
}

/**
 * Main recording loop - runs until stopped (original behavior)
 * This is used for manual/non-scheduled recording
 */
export async function startRecording(): Promise<void> {
	const config = getConfig()

	logger.info({ sessionId: config.sessionId }, "Starting recording service")

	// Clear any existing finish trigger
	await clearFinishTrigger()

	// Start the session
	const started = await startRecordingSession(config.sessionId)
	if (!started) {
		logger.fatal("Failed to start recording")
		process.exit(1)
	}

	logger.info(
		"Recording started (gapless mode with file rotation). Touch finish trigger file to stop gracefully.",
	)

	// Handle graceful shutdown
	const shutdown = () => {
		logger.info("Shutdown signal received")
		stopRecordingInternal()
	}

	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)

	// Monitor for finish trigger in background
	const triggerCheck = async () => {
		while (state.isRunning) {
			if (await checkFinishTrigger()) {
				logger.info("Finish trigger detected, stopping recording")
				await clearFinishTrigger()
				stopRecordingInternal()
				break
			}
			await Bun.sleep(1000)
		}
	}
	triggerCheck() // Start in background (don't await)

	// Wait for recording to stop
	if (recordingStoppedPromise) {
		await recordingStoppedPromise
	}

	// Stop JACK server if we auto-started it
	await stopJackServer()

	logger.info("Recording service finished")
}
