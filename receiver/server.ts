/**
 * XR18 Audio Stream Receiver
 *
 * Entry point for the receiver server.
 *
 * Architecture:
 * - config.ts: Centralized configuration
 * - db/: SQLite database layer
 * - utils/: Utility functions (logging, FFmpeg, paths)
 * - services/: Business logic (storage, upload queue, session management)
 * - pipeline/: Step-based audio processing
 * - routes/: Hono HTTP routes
 */
import { createLogger } from "./utils/logger";
import { config } from "./config";
import { initDatabase } from "./db/index";
import { checkFfmpeg, checkAudiowaveform } from "./utils/ffmpeg";
import { ensureDir } from "./services/storage";
import { startSessionManager, stopSessionManager } from "./services/session";
import app from "./routes";

const logger = createLogger("Server");

async function main() {
  // Ensure storage directory exists
  await ensureDir(config.localStorage.dir);

  // Initialize database
  initDatabase();

  // Check for required tools
  const hasFfmpeg = await checkFfmpeg();
  const hasAudiowaveform = await checkAudiowaveform();

  if (!hasFfmpeg) {
    logger.warn("ffmpeg not found. Audio processing will fail.");
    logger.warn("Install with: sudo apt install ffmpeg");
  }

  if (!hasAudiowaveform) {
    logger.warn("audiowaveform not found. Waveform peaks generation will fail.");
    logger.warn("Install from: https://github.com/bbc/audiowaveform");
  }

  // Log startup info
  logger.info("XR18 Stream Receiver starting...");
  logger.info(`  Port: ${config.port}`);
  logger.info(`  Local Storage: ${config.localStorage.dir}`);
  logger.info(`  S3 Enabled: ${config.s3.enabled}`);
  if (config.s3.enabled) {
    logger.info(`  S3 Bucket: ${config.s3.bucket}`);
    logger.info(`  S3 Prefix: ${config.s3.prefix}`);
  }
  logger.info(`  FFmpeg: ${hasFfmpeg ? "available" : "NOT FOUND"}`);
  logger.info(`  Audiowaveform: ${hasAudiowaveform ? "available" : "NOT FOUND"}`);
  logger.info("");

  // Check for required S3 config
  if (config.s3.enabled && !config.s3.credentials.accessKeyId && !process.env.AWS_PROFILE) {
    logger.warn("S3 enabled but no AWS credentials configured.");
    logger.warn("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or use AWS_PROFILE");
    logger.warn("");
  }

  // Start session manager (handles timeout detection and processing)
  startSessionManager();

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    stopSessionManager();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start Hono server
  Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });

  logger.info(`Server running at http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
