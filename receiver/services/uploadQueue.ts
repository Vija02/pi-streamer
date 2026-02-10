/**
 * Upload Queue Service
 *
 * Background queue for uploading files to S3 with retry logic.
 */
import { mkdir, writeFile, readdir, unlink, readFile } from "fs/promises";
import { join } from "path";
import { createLogger } from "../utils/logger";
import { config } from "../config";
import { uploadFileToS3, isS3Enabled } from "./storage";
import { getFailedUploadsDir } from "../utils/paths";
import { updateSegmentS3Key } from "../db/segments";

const logger = createLogger("UploadQueue");

// =============================================================================
// TYPES
// =============================================================================

export interface UploadQueueItem {
  localPath: string;
  s3Key: string;
  contentType: string;
  retries: number;
  addedAt: number;
  segmentDbId?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// QUEUE STATE
// =============================================================================

const uploadQueue: UploadQueueItem[] = [];
let uploadQueueRunning = false;
let activeUploads = 0;

// =============================================================================
// QUEUE OPERATIONS
// =============================================================================

/**
 * Add an item to the upload queue
 */
export function addToUploadQueue(
  localPath: string,
  s3Key: string,
  contentType: string,
  segmentDbId?: number,
  metadata?: Record<string, unknown>
): void {
  if (!isS3Enabled()) {
    logger.debug("S3 disabled, not queueing upload");
    return;
  }

  uploadQueue.push({
    localPath,
    s3Key,
    contentType,
    retries: 0,
    addedAt: Date.now(),
    segmentDbId,
    metadata,
  });

  logger.debug(`Queued for upload: ${localPath} -> s3://${config.s3.bucket}/${s3Key}`);

  // Start queue processor if not running
  if (!uploadQueueRunning) {
    processUploadQueue();
  }
}

/**
 * Process the upload queue
 */
async function processUploadQueue(): Promise<void> {
  if (uploadQueueRunning) return;
  uploadQueueRunning = true;

  logger.info("Upload queue processor started");

  while (uploadQueue.length > 0 || activeUploads > 0) {
    // Process items up to concurrency limit
    while (
      activeUploads < config.uploadQueue.concurrency &&
      uploadQueue.length > 0
    ) {
      const item = uploadQueue.shift();
      if (!item) continue;

      activeUploads++;

      // Process upload (don't await, run concurrently)
      processUploadItem(item).finally(() => {
        activeUploads--;
      });
    }

    // Wait before checking queue again
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  uploadQueueRunning = false;
  logger.info("Upload queue processor stopped (queue empty)");
}

/**
 * Process a single upload item
 */
async function processUploadItem(item: UploadQueueItem): Promise<void> {
  const result = await uploadFileToS3(item.localPath, item.s3Key, item.contentType);

  if (result) {
    // Update segment in database with S3 key
    if (item.segmentDbId) {
      updateSegmentS3Key(item.segmentDbId, item.s3Key);
      logger.debug(`Updated segment ${item.segmentDbId} with S3 key: ${item.s3Key}`);
    }
  } else {
    // Upload failed
    item.retries++;

    if (item.retries < config.uploadQueue.maxRetries) {
      logger.warn(
        `Will retry upload (${item.retries}/${config.uploadQueue.maxRetries}): ${item.localPath}`
      );

      // Add back to queue with delay
      setTimeout(() => {
        uploadQueue.push(item);
      }, config.uploadQueue.retryIntervalMs);
    } else {
      logger.error(
        `Upload permanently failed after ${item.retries} retries: ${item.localPath}`
      );

      // Save failed upload info for manual retry later
      await saveFailedUploadInfo(item);
    }
  }
}

/**
 * Save failed upload info for manual retry
 */
async function saveFailedUploadInfo(item: UploadQueueItem): Promise<void> {
  const failedDir = getFailedUploadsDir();
  await mkdir(failedDir, { recursive: true });

  const filename = `${Date.now()}_${item.s3Key.replace(/\//g, "_")}.json`;
  const filepath = join(failedDir, filename);

  await writeFile(filepath, JSON.stringify(item, null, 2));
  logger.info(`Saved failed upload info: ${filepath}`);
}

/**
 * Retry all failed uploads
 */
export async function retryFailedUploads(): Promise<number> {
  const failedDir = getFailedUploadsDir();

  try {
    const files = await readdir(failedDir);
    let retried = 0;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filepath = join(failedDir, file);
      const content = await readFile(filepath, "utf-8");
      const item: UploadQueueItem = JSON.parse(content);

      // Reset retries and add back to queue
      item.retries = 0;
      uploadQueue.push(item);

      // Remove the failed file
      await unlink(filepath);
      retried++;
    }

    // Start queue processor if not running
    if (retried > 0 && !uploadQueueRunning) {
      processUploadQueue();
    }

    logger.info(`Retrying ${retried} failed uploads`);
    return retried;
  } catch (error) {
    logger.debug("No failed uploads to retry");
    return 0;
  }
}

/**
 * Get upload queue status
 */
export function getUploadQueueStatus(): {
  pending: number;
  activeUploads: number;
  running: boolean;
} {
  return {
    pending: uploadQueue.length,
    activeUploads,
    running: uploadQueueRunning,
  };
}

/**
 * Clear the upload queue (use with caution)
 */
export function clearUploadQueue(): void {
  uploadQueue.length = 0;
  logger.warn("Upload queue cleared");
}
