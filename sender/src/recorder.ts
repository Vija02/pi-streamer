/**
 * FFmpeg recording functionality
 */
import { $ } from "bun";
import { join } from "path";
import { getConfig } from "./config";
import { recordingLogger as logger } from "./logger";
import { formatTimestamp } from "./utils";
import { checkJackSetup, connectJackPorts } from "./jack";
import { queueUpload, waitForQueueEmpty, getQueueLength } from "./upload";

/**
 * Record a single segment using FFmpeg
 */
async function recordSegment(outputPath: string): Promise<boolean> {
  const config = getConfig();
  const { channels, jackClientName, sampleRate, segmentDuration } = config;

  try {
    await $`ffmpeg -y \
      -f jack \
      -channels ${channels} \
      -i ${jackClientName} \
      -ar ${sampleRate} \
      -t ${segmentDuration} \
      -c:a flac \
      -compression_level 0 \
      ${outputPath}`.quiet();
    return true;
  } catch {
    // FFmpeg may return non-zero on timeout, but file could still be valid
    return await Bun.file(outputPath).exists();
  }
}

export interface RecorderState {
  isRunning: boolean;
  segmentCount: number;
  sessionDir: string;
}

let state: RecorderState = {
  isRunning: false,
  segmentCount: 0,
  sessionDir: "",
};

/**
 * Check if the finish trigger file exists
 */
async function checkFinishTrigger(): Promise<boolean> {
  const config = getConfig();
  return await Bun.file(config.finishTriggerPath).exists();
}

/**
 * Remove the finish trigger file
 */
async function clearFinishTrigger(): Promise<void> {
  const config = getConfig();
  try {
    await $`rm -f ${config.finishTriggerPath}`.quiet();
  } catch {
    // Ignore errors
  }
}

/**
 * Stop the recording loop
 */
export function stopRecording(): void {
  state.isRunning = false;
}

/**
 * Get the current recorder state
 */
export function getRecorderState(): RecorderState {
  return { ...state };
}

/**
 * Main recording loop - runs until stopped
 */
export async function startRecording(): Promise<void> {
  const config = getConfig();

  logger.info({ sessionId: config.sessionId }, "Starting recording service");

  // Clear any existing finish trigger
  await clearFinishTrigger();

  // Check JACK setup
  const jackCheck = await checkJackSetup();
  if (!jackCheck.ok) {
    logger.fatal("JACK server is not running. Start JACK first.");
    process.exit(1);
  }

  // Create session directory
  const sessionDir = join(config.recordingDir, config.sessionId);
  await $`mkdir -p ${sessionDir}`;
  state.sessionDir = sessionDir;

  logger.info({
    channels: config.channels,
    sampleRate: config.sampleRate,
    segmentDuration: config.segmentDuration,
    recordingDir: sessionDir,
    uploadEnabled: config.uploadEnabled,
    streamUrl: config.uploadEnabled ? config.streamUrl : undefined,
    finishTrigger: config.finishTriggerPath,
  }, "Configuration loaded");

  let segmentNumber = 0;
  let jackConnected = false;
  state.isRunning = true;

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info("Shutdown signal received");
    state.isRunning = false;
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Recording loop started. Touch finish trigger file to stop gracefully.");

  while (state.isRunning) {
    // Check for finish trigger
    if (await checkFinishTrigger()) {
      logger.info("Finish trigger detected, stopping after current segment");
      state.isRunning = false;
      await clearFinishTrigger();
      // Continue to finish current segment
    }

    const timestamp = formatTimestamp(new Date());
    const segmentFile = join(
      sessionDir,
      `seg_${String(segmentNumber).padStart(5, "0")}_${timestamp}.${config.recordingFormat}`
    );

    logger.info(
      { segment: segmentNumber, file: segmentFile.split("/").pop() },
      "Recording segment"
    );

    // Start FFmpeg recording
    const recordPromise = recordSegment(segmentFile);

    // Connect JACK ports on first segment (FFmpeg needs to be running first)
    if (!jackConnected) {
      await Bun.sleep(1000);
      await connectJackPorts();
      jackConnected = true;
    }

    // Wait for segment to complete
    await recordPromise;

    // Queue for upload if enabled
    if (config.uploadEnabled && (await Bun.file(segmentFile).exists())) {
      queueUpload(segmentFile, segmentNumber);
    }

    segmentNumber++;
    state.segmentCount = segmentNumber;
  }

  logger.info({ segments: segmentNumber }, "Recording stopped");

  // Wait for upload queue to finish
  const pendingUploads = getQueueLength();
  if (pendingUploads > 0) {
    logger.info({ pending: pendingUploads }, "Waiting for pending uploads to complete");
    await waitForQueueEmpty();
  }

  logger.info("Recording service finished");
}
