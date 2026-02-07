/**
 * File watcher for completed recording segments
 *
 * Monitors the session directory for new .wav files created by jack_capture.
 * When a new file appears, it means the previous file is complete and can be
 * uploaded.
 *
 * Logic:
 * - jack_capture creates files like: jack_capture_001.wav, jack_capture_002.wav, etc.
 * - When jack_capture_002.wav appears, jack_capture_001.wav is complete
 * - We queue the completed file for upload
 * - On shutdown, we queue the final (current) file
 */
import { watch, type FSWatcher } from "fs"
import { readdir } from "fs/promises"
import { join } from "path"
import { watcherLogger as logger } from "./logger"
import { queueUpload } from "./upload"

interface WatcherState {
	sessionDir: string
	watcher: FSWatcher | null
	seenFiles: Set<string>
	queuedFiles: Set<string>
	isRunning: boolean
}

const state: WatcherState = {
	sessionDir: "",
	watcher: null,
	seenFiles: new Set(),
	queuedFiles: new Set(),
	isRunning: false,
}

/**
 * Extract segment number from jack_capture filename
 * e.g., "jack_capture_001.wav" -> 1
 */
function extractSegmentNumber(filename: string): number {
	const match = filename.match(/jack_capture_(\d+)\.wav$/)
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
			.filter((f) => f.endsWith(".wav") && f.startsWith("jack_capture_"))
			.sort((a, b) => extractSegmentNumber(a) - extractSegmentNumber(b))
	} catch {
		return []
	}
}

/**
 * Queue a file for upload if not already queued
 */
function queueFileForUpload(filename: string): void {
	if (state.queuedFiles.has(filename)) {
		return
	}

	const filePath = join(state.sessionDir, filename)
	const segmentNumber = extractSegmentNumber(filename)

	if (segmentNumber < 0) {
		logger.warn({ filename }, "Could not extract segment number from filename")
		return
	}

	logger.info({ filename, segmentNumber }, "Queueing completed segment for upload")
	state.queuedFiles.add(filename)
	queueUpload(filePath, segmentNumber)
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

	// Queue all files except the last one (which is still being written)
	// The last file will be queued when recording stops or a new file appears
	for (let i = 0; i < sortedFiles.length - 1; i++) {
		queueFileForUpload(sortedFiles[i])
	}
}

/**
 * Handle file system events
 */
function handleFsEvent(eventType: string, filename: string | null): void {
	if (!state.isRunning) return
	if (!filename) return
	if (!filename.endsWith(".wav")) return
	if (!filename.startsWith("jack_capture_")) return

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
		state.isRunning = false
	}
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

	// Wait a moment for any final file writes to complete
	await Bun.sleep(500)

	// Do a final scan and queue ALL remaining files (including the last one)
	const finalFiles = await getWavFiles(state.sessionDir)

	for (const file of finalFiles) {
		state.seenFiles.add(file)
		queueFileForUpload(file)
	}

	logger.info(
		{ totalFiles: state.seenFiles.size, queuedFiles: state.queuedFiles.size },
		"Watcher stopped, queued remaining files"
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
