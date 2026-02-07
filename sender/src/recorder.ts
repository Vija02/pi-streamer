/**
 * jack_capture recording functionality
 *
 * Uses jack_capture instead of FFmpeg because FFmpeg JACK input
 * only supports up to 8 channels, while XR18 has 18 channels.
 */
import { $ } from "bun"
import { join } from "path"
import { getConfig } from "./config"
import { recordingLogger as logger } from "./logger"
import { formatTimestamp } from "./utils"
import { checkJackSetup, getSourcePorts } from "./jack"
import { queueUpload, waitForQueueEmpty, getQueueLength } from "./upload"

/**
 * Record a single segment using jack_capture
 */
async function recordSegment(outputPath: string): Promise<boolean> {
	const config = getConfig()
	const { channels, segmentDuration, jackPortPrefix } = config

	// Build port arguments for jack_capture
	// jack_capture uses -p for each port to capture
	const portArgs: string[] = []
	for (let i = 1; i <= channels; i++) {
		portArgs.push("-p", `${jackPortPrefix}${i}`)
	}

	try {
		// jack_capture options:
		// -d <duration> : recording duration in seconds
		// -f <format>   : output format (wav - note: flac not supported by libsndfile)
		// -b <bits>     : bit depth
		// -p <port>     : port to capture (repeat for each port)
		// -fn <file>    : output filename
		await $`jack_capture \
      -d ${segmentDuration} \
      -f wav \
      -b 24 \
      ${portArgs} \
      -fn ${outputPath}`.quiet()
		return true
	} catch (err: any) {
		const stderr = err?.stderr?.toString?.() || ""
		// jack_capture may exit with error but still produce valid file
		if (await Bun.file(outputPath).exists()) {
			logger.warn(
				{ stderr: stderr.trim() },
				"jack_capture exited with error but file exists",
			)
			return true
		}
		logger.error({ error: stderr.trim() }, "jack_capture failed")
		return false
	}
}

export interface RecorderState {
	isRunning: boolean
	segmentCount: number
	sessionDir: string
}

let state: RecorderState = {
	isRunning: false,
	segmentCount: 0,
	sessionDir: "",
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
 * Stop the recording loop
 */
export function stopRecording(): void {
	state.isRunning = false
}

/**
 * Get the current recorder state
 */
export function getRecorderState(): RecorderState {
	return { ...state }
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

	// Create session directory
	const sessionDir = join(config.recordingDir, config.sessionId)
	await $`mkdir -p ${sessionDir}`
	state.sessionDir = sessionDir

	logger.info(
		{
			channels: config.channels,
			sampleRate: config.sampleRate,
			segmentDuration: config.segmentDuration,
			recordingDir: sessionDir,
			uploadEnabled: config.uploadEnabled,
			streamUrl: config.uploadEnabled ? config.streamUrl : undefined,
			finishTrigger: config.finishTriggerPath,
			jackPortPrefix: config.jackPortPrefix,
		},
		"Configuration loaded",
	)

	let segmentNumber = 0
	state.isRunning = true

	// Handle graceful shutdown
	const shutdown = () => {
		logger.info("Shutdown signal received")
		state.isRunning = false
	}

	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)

	logger.info(
		"Recording loop started. Touch finish trigger file to stop gracefully.",
	)

	while (state.isRunning) {
		// Check for finish trigger
		if (await checkFinishTrigger()) {
			logger.info("Finish trigger detected, stopping after current segment")
			state.isRunning = false
			await clearFinishTrigger()
			// Continue to finish current segment
		}

		const timestamp = formatTimestamp(new Date())
		const segmentFile = join(
			sessionDir,
			`seg_${String(segmentNumber).padStart(5, "0")}_${timestamp}.${config.recordingFormat}`,
		)

		logger.info(
			{ segment: segmentNumber, file: segmentFile.split("/").pop() },
			"Recording segment",
		)

		// Record segment using jack_capture
		const success = await recordSegment(segmentFile)

		if (!success) {
			logger.error(
				{ segment: segmentNumber },
				"Failed to record segment, retrying...",
			)
			await Bun.sleep(1000)
			continue
		}

		// Queue for upload if enabled
		if (config.uploadEnabled && (await Bun.file(segmentFile).exists())) {
			queueUpload(segmentFile, segmentNumber)
		}

		segmentNumber++
		state.segmentCount = segmentNumber
	}

	logger.info({ segments: segmentNumber }, "Recording stopped")

	// Wait for upload queue to finish
	const pendingUploads = getQueueLength()
	if (pendingUploads > 0) {
		logger.info(
			{ pending: pendingUploads },
			"Waiting for pending uploads to complete",
		)
		await waitForQueueEmpty()
	}

	logger.info("Recording service finished")
}
