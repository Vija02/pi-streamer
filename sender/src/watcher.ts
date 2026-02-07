/**
 * File watcher for completed recording segments
 *
 * Monitors the session directory for new .wav files created by jack_capture.
 * When a new file appears, it means the previous file is complete and can be
 * compressed and uploaded.
 *
 * Logic:
 * - jack_capture creates files like: jack_capture_001.wav, jack_capture_002.wav, etc.
 * - When jack_capture_002.wav appears, jack_capture_001.wav is complete
 * - We compress the WAV to FLAC (split into channel groups) and queue for upload
 * - On shutdown, we process the final (current) file
 */
import { watch, type FSWatcher } from "fs"
import { readdir } from "fs/promises"
import { join } from "path"
import { watcherLogger as logger } from "./logger"
import { queueUpload } from "./upload"
import { compressWavToFlac, deleteOriginalWav } from "./compress"
import { getConfig } from "./config"

interface WatcherState {
	sessionDir: string
	watcher: FSWatcher | null
	pollInterval: Timer | null
	seenFiles: Set<string>
	queuedFiles: Set<string>
	processingFiles: Set<string>  // Files currently being compressed
	isRunning: boolean
}

const state: WatcherState = {
	sessionDir: "",
	watcher: null,
	pollInterval: null,
	seenFiles: new Set(),
	queuedFiles: new Set(),
	processingFiles: new Set(),
	isRunning: false,
}

// Poll interval in milliseconds (fallback for unreliable fs.watch)
const POLL_INTERVAL_MS = 5000

/**
 * Extract segment number from jack_capture filename
 * e.g., "jack_capture.00.wav" -> 0, "jack_capture.01.wav" -> 1
 */
function extractSegmentNumber(filename: string): number {
	const match = filename.match(/jack_capture\.(\d+)\.wav$/)
	if (match) {
		return parseInt(match[1], 10)
	}
	return -1
}

/**
 * Get all wav files in the session directory, sorted by segment number
 */
async function getWavFiles(dir: string): Promise<string[]> {
	try {
		const files = await readdir(dir)
		return files
			.filter((f) => f.endsWith(".wav") && f.startsWith("jack_capture."))
			.sort((a, b) => extractSegmentNumber(a) - extractSegmentNumber(b))
	} catch {
		return []
	}
}

/**
 * Process a completed WAV file: compress to FLAC and queue for upload
 */
async function processFileForUpload(filename: string): Promise<void> {
	// Skip if already queued or currently processing
	if (state.queuedFiles.has(filename) || state.processingFiles.has(filename)) {
		return
	}

	const filePath = join(state.sessionDir, filename)
	const segmentNumber = extractSegmentNumber(filename)

	if (segmentNumber < 0) {
		logger.warn({ filename }, "Could not extract segment number from filename")
		return
	}

	const config = getConfig()

	// Mark as processing
	state.processingFiles.add(filename)

	try {
		if (config.compressionEnabled) {
			// Compress WAV to FLAC channel groups
			logger.info({ filename, segmentNumber }, "Compressing segment")
			const compressed = await compressWavToFlac(filePath, segmentNumber)

			// Queue each FLAC file for upload
			for (const flacPath of compressed.flacFiles) {
				queueUpload(flacPath, segmentNumber)
			}

			// Delete original WAV to save space
			if (config.deleteAfterCompress) {
				await deleteOriginalWav(filePath)
			}
		} else {
			// No compression - upload WAV directly
			queueUpload(filePath, segmentNumber)
		}

		state.queuedFiles.add(filename)
		logger.info({ filename, segmentNumber }, "Segment processed and queued for upload")
	} catch (err) {
		logger.error({ err, filename }, "Failed to process segment")
		// Remove from processing so it can be retried
		state.processingFiles.delete(filename)
	} finally {
		state.processingFiles.delete(filename)
	}
}

/**
 * Process new files - queue completed segments for upload
 */
async function processNewFiles(): Promise<void> {
	const currentFiles = await getWavFiles(state.sessionDir)

	for (const file of currentFiles) {
		if (!state.seenFiles.has(file)) {
			state.seenFiles.add(file)
			logger.debug({ file }, "New file detected")
		}
	}

	// Sort files by segment number
	const sortedFiles = Array.from(state.seenFiles).sort(
		(a, b) => extractSegmentNumber(a) - extractSegmentNumber(b)
	)

	// Process all files except the last one (which is still being written)
	// The last file will be processed when recording stops or a new file appears
	for (let i = 0; i < sortedFiles.length - 1; i++) {
		// Don't await - process in background
		processFileForUpload(sortedFiles[i]).catch((err) => {
			logger.error({ err, file: sortedFiles[i] }, "Error processing file")
		})
	}
}

/**
 * Handle file system events
 */
function handleFsEvent(eventType: string, filename: string | null): void {
	if (!state.isRunning) return
	if (!filename) return
	if (!filename.endsWith(".wav")) return
	if (!filename.startsWith("jack_capture.")) return

	logger.debug({ eventType, filename }, "File system event")

	// Process files asynchronously
	processNewFiles().catch((err) => {
		logger.error({ err }, "Error processing new files")
	})
}

/**
 * Start watching a directory for new segment files
 */
export function startWatcher(sessionDir: string): void {
	if (state.isRunning) {
		logger.warn("Watcher already running")
		return
	}

	state.sessionDir = sessionDir
	state.seenFiles = new Set()
	state.queuedFiles = new Set()
	state.processingFiles = new Set()
	state.isRunning = true

	// Do an initial scan for any existing files
	processNewFiles().catch((err) => {
		logger.error({ err }, "Error in initial file scan")
	})

	// Start watching for new files
	try {
		state.watcher = watch(sessionDir, { persistent: false }, handleFsEvent)
		logger.info({ sessionDir }, "Started watching for segment files")
	} catch (err) {
		logger.error({ err, sessionDir }, "Failed to start file watcher")
		// Continue anyway - we have polling as fallback
	}

	// Also poll periodically as fallback (fs.watch can be unreliable on Linux)
	state.pollInterval = setInterval(() => {
		if (state.isRunning) {
			processNewFiles().catch((err) => {
				logger.error({ err }, "Error in poll scan")
			})
		}
	}, POLL_INTERVAL_MS)
	logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "Started polling for segment files")
}

/**
 * Stop the watcher and queue any remaining files
 */
export async function stopWatcher(): Promise<void> {
	if (!state.isRunning) return

	state.isRunning = false

	// Close the file watcher
	if (state.watcher) {
		state.watcher.close()
		state.watcher = null
	}

	// Stop polling
	if (state.pollInterval) {
		clearInterval(state.pollInterval)
		state.pollInterval = null
	}

	// Wait a moment for any final file writes to complete
	await Bun.sleep(1000)

	// Do a final scan and process ALL remaining files (including the last one)
	const finalFiles = await getWavFiles(state.sessionDir)

	// Process all remaining files - must await for these since we're shutting down
	for (const file of finalFiles) {
		state.seenFiles.add(file)
		if (!state.queuedFiles.has(file) && !state.processingFiles.has(file)) {
			try {
				await processFileForUpload(file)
			} catch (err) {
				logger.error({ err, file }, "Error processing final file")
			}
		}
	}

	logger.info(
		{ totalFiles: state.seenFiles.size, queuedFiles: state.queuedFiles.size },
		"Watcher stopped, processed remaining files"
	)
}

/**
 * Get watcher status
 */
export function getWatcherStatus(): { isRunning: boolean; seenFiles: number; queuedFiles: number } {
	return {
		isRunning: state.isRunning,
		seenFiles: state.seenFiles.size,
		queuedFiles: state.queuedFiles.size,
	}
}
