/**
 * XR18 JACK Audio Sender Service
 *
 * A recording service that captures 18 channels from XR18 via JACK using jack_capture.
 * 
 * Features:
 * - Records locally as segments (primary - always works)
 * - Uploads completed segments to server in background
 * - Graceful shutdown via SIGINT, SIGTERM, or finish trigger file
 *
 * This design prioritizes data safety:
 * - Local recording happens first (never lost even if network fails)
 * - Segments are uploaded after being fully written
 * - If recorder shuts off, you only lose the current segment
 *
 * Requirements:
 * - JACK audio server running with XR18 connected
 * - jack_capture installed (supports unlimited channels, unlike FFmpeg's 8-channel limit)
 *
 * To stop gracefully, either:
 * - Send SIGINT (Ctrl+C) or SIGTERM
 * - Touch the finish trigger file (default: /tmp/xr18-finish)
 */

import { logger } from "./logger";
import { getConfig } from "./config";
import { commandExists } from "./utils";
import { startRecording } from "./recorder";
import { checkJackSetup, getCapturePorts } from "./jack";
import { uploadPending } from "./upload";

/**
 * Check that all required dependencies are installed
 */
async function checkDependencies(): Promise<string[]> {
  const config = getConfig();
  const missing: string[] = [];

  if (!(await commandExists("jack_capture"))) missing.push("jack_capture");
  if (!(await commandExists("jack_lsp"))) missing.push("jack (jack_lsp)");

  // ffmpeg is required for compression (splitting 18-channel WAV to FLAC)
  if (config.compressionEnabled && !(await commandExists("ffmpeg"))) {
    missing.push("ffmpeg");
  }

  return missing;
}

/**
 * Test JACK setup and show available ports
 */
async function testJack(): Promise<void> {
  logger.info("Testing JACK setup...");

  const missing = await checkDependencies();
  if (missing.length > 0) {
    logger.fatal({ missing }, "Missing dependencies. Install with: sudo apt install jack-capture jackd2");
    process.exit(1);
  }

  const jackCheck = await checkJackSetup();
  if (!jackCheck.ok) {
    logger.fatal("JACK server is not running. Start JACK first, e.g.: jackd -d alsa -d hw:XR18 -r 48000");
    process.exit(1);
  }

  const config = getConfig();
  const capturePorts = await getCapturePorts();

  logger.info({ ports: capturePorts }, "Available JACK capture ports");
  logger.info({ prefix: config.jackPortPrefix }, "Current JACK_PORT_PREFIX");
  logger.info("Set JACK_PORT_PREFIX environment variable to match your XR18 ports.");
  logger.info("Test complete.");
}

/**
 * Main service entry point
 */
async function main(): Promise<void> {
  const command = process.argv[2];

  // Handle special commands
  if (command === "test") {
    await testJack();
    return;
  }

  if (command === "upload-pending") {
    await uploadPending();
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`XR18 Audio Sender Service

Usage: bun run src/index.ts [command]

Commands:
  (default)      - Start recording service
  test           - Test JACK setup
  upload-pending - Retry uploading any failed segments
  help           - Show this help message

Environment variables:
  STREAM_URL            - Server URL (default: http://localhost:3000/stream)
  RECORDING_DIR         - Local directory (default: ./recordings)
  SAMPLE_RATE           - Audio sample rate (default: 48000)
  CHANNELS              - Number of channels (default: 18)
  JACK_PORT_PREFIX      - JACK port prefix (default: system:capture_)
  SESSION_ID            - Session identifier (default: timestamp)
  SEGMENT_DURATION      - Segment length in seconds (default: 30)
  UPLOAD_ENABLED        - Enable server upload (default: true)
  UPLOAD_RETRY_COUNT    - Upload retry attempts (default: 3)
  COMPRESSION_ENABLED   - Compress WAV to FLAC before upload (default: true)
  DELETE_AFTER_COMPRESS - Delete WAV after compression (default: true)
  FINISH_TRIGGER_PATH   - File to touch to stop recording (default: /tmp/xr18-finish)
  LOG_LEVEL             - Logging level: trace, debug, info, warn, error (default: info)
  NODE_ENV              - Set to "production" for JSON logging

JACK auto-start settings:
  JACK_AUTO_START       - Auto-start JACK if not running (default: true)
  JACK_DRIVER           - JACK driver (default: alsa)
  JACK_DEVICE           - JACK device (default: hw:XR18)
  JACK_SAMPLE_RATE      - JACK sample rate (default: 48000)
  JACK_PERIOD_SIZE      - JACK period size (default: 2048)
  JACK_NPERIODS         - JACK number of periods (default: 3)
  JACK_STARTUP_WAIT_MS  - Time to wait for JACK startup (default: 3000)
`);
    return;
  }

  // Default: start recording service
  logger.info("XR18 Audio Sender Service starting...");

  // Check dependencies
  const missing = await checkDependencies();
  if (missing.length > 0) {
    logger.fatal({ missing }, "Missing dependencies. Install with: sudo apt install jack-capture jackd2 ffmpeg");
    process.exit(1);
  }

  // Start recording
  await startRecording();
}

// Run
main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
