/**
 * Upload queue management
 */
import { $ } from "bun";
import { join } from "path";
import { getConfig } from "./config";
import { uploadLogger as logger } from "./logger";

export interface UploadQueueItem {
  filePath: string;
  segmentNumber: number;
  retries: number;
}

const uploadQueue: UploadQueueItem[] = [];
let uploadQueueRunning = false;

/**
 * Upload a single file to the server
 */
async function uploadFile(
  filePath: string,
  segmentNumber: number,
  sessionId: string
): Promise<boolean> {
  const config = getConfig();

  try {
    const file = Bun.file(filePath);
    const fileData = await file.arrayBuffer();
    const fileName = filePath.split("/").pop();

    const response = await fetch(config.streamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "audio/flac",
        "X-Session-ID": sessionId,
        "X-Segment-Number": String(segmentNumber),
        "X-Sample-Rate": String(config.sampleRate),
        "X-Channels": String(config.channels),
      },
      body: fileData,
    });

    if (response.ok) {
      logger.info({ file: fileName, segmentNumber }, "Uploaded segment");
      return true;
    } else {
      logger.warn(
        { file: fileName, status: response.status },
        "Upload failed"
      );
      return false;
    }
  } catch (err) {
    logger.error({ err, filePath }, "Upload error");
    return false;
  }
}

/**
 * Save info about a failed upload for later retry
 */
async function saveFailedUpload(item: UploadQueueItem): Promise<void> {
  const config = getConfig();
  const failedDir = join(config.recordingDir, config.sessionId, ".failed");
  await $`mkdir -p ${failedDir}`;

  const infoPath = join(failedDir, `seg_${item.segmentNumber}.json`);
  await Bun.write(
    infoPath,
    JSON.stringify(
      {
        filePath: item.filePath,
        segmentNumber: item.segmentNumber,
        sessionId: config.sessionId,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );

  logger.info({ infoPath }, "Saved failed upload info for retry");
}

/**
 * Process the upload queue
 */
async function processUploadQueue(): Promise<void> {
  if (uploadQueueRunning) return;
  uploadQueueRunning = true;

  const config = getConfig();

  while (uploadQueue.length > 0) {
    const item = uploadQueue.shift();
    if (!item) continue;

    const success = await uploadFile(item.filePath, item.segmentNumber, config.sessionId);

    if (!success) {
      item.retries++;
      if (item.retries < config.uploadRetryCount) {
        logger.info(
          { file: item.filePath.split("/").pop(), attempt: item.retries, max: config.uploadRetryCount },
          "Will retry upload"
        );
        // Add back to queue after delay
        setTimeout(() => {
          uploadQueue.push(item);
          if (!uploadQueueRunning) processUploadQueue();
        }, config.uploadRetryDelay);
      } else {
        logger.error(
          { file: item.filePath.split("/").pop() },
          "Upload permanently failed"
        );
        await saveFailedUpload(item);
      }
    }
  }

  uploadQueueRunning = false;
}

/**
 * Add a file to the upload queue
 */
export function queueUpload(filePath: string, segmentNumber: number): void {
  uploadQueue.push({ filePath, segmentNumber, retries: 0 });

  if (!uploadQueueRunning) {
    processUploadQueue();
  }
}

/**
 * Get the current queue length
 */
export function getQueueLength(): number {
  return uploadQueue.length;
}

/**
 * Check if the upload queue is currently processing
 */
export function isQueueRunning(): boolean {
  return uploadQueueRunning;
}

/**
 * Wait for the upload queue to be empty
 */
export async function waitForQueueEmpty(): Promise<void> {
  while (uploadQueue.length > 0 || uploadQueueRunning) {
    await Bun.sleep(500);
  }
}

/**
 * Retry uploading previously failed segments
 */
export async function uploadPending(): Promise<number> {
  const config = getConfig();

  logger.info("Scanning for pending uploads...");

  let count = 0;

  const recordingDir = Bun.file(config.recordingDir);
  if (!(await recordingDir.exists())) {
    logger.info("No recordings directory found");
    return 0;
  }

  const glob = new Bun.Glob("**/.failed/*.json");
  for await (const file of glob.scan(config.recordingDir)) {
    const infoPath = join(config.recordingDir, file);
    const content = await Bun.file(infoPath).json();

    logger.info({ filePath: content.filePath }, "Retrying failed upload");

    const success = await uploadFile(
      content.filePath,
      content.segmentNumber,
      content.sessionId
    );

    if (success) {
      await $`rm ${infoPath}`;
      count++;
    }
  }

  logger.info({ count }, "Uploaded pending files");
  return count;
}
