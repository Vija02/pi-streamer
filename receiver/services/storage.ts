/**
 * Storage Service
 *
 * Unified storage operations for local files and S3.
 */
import { S3Client } from "bun";
import { mkdir, unlink, readdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { createLogger } from "../utils/logger";
import { config } from "../config";
import { buildS3Url, getStorageDir, getSessionDir } from "../utils/paths";

const logger = createLogger("Storage");

// =============================================================================
// S3 CLIENT
// =============================================================================

let s3Client: S3Client | null = null;

/**
 * Get the S3 client instance (initializes if needed)
 */
export function getS3Client(): S3Client | null {
  if (!config.s3.enabled) {
    return null;
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      accessKeyId: config.s3.credentials.accessKeyId || undefined,
      secretAccessKey: config.s3.credentials.secretAccessKey || undefined,
      bucket: config.s3.bucket,
    });
  }

  return s3Client;
}

/**
 * Check if S3 is enabled
 */
export function isS3Enabled(): boolean {
  return config.s3.enabled;
}

// =============================================================================
// LOCAL FILE OPERATIONS
// =============================================================================

/**
 * Ensure a directory exists
 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Save data to a local file
 */
export async function saveLocalFile(
  filePath: string,
  data: Uint8Array | ArrayBuffer
): Promise<void> {
  await ensureDir(dirname(filePath));

  const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
  await Bun.write(filePath, buffer);

  logger.debug(`Saved local file: ${filePath} (${buffer.length} bytes)`);
}

/**
 * Read a local file
 */
export async function readLocalFile(filePath: string): Promise<Uint8Array> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Check if a local file exists
 */
export async function localFileExists(filePath: string): Promise<boolean> {
  const file = Bun.file(filePath);
  return await file.exists();
}

/**
 * Get local file size
 */
export async function getLocalFileSize(filePath: string): Promise<number> {
  const stats = await stat(filePath);
  return stats.size;
}

/**
 * Delete a local file
 */
export async function deleteLocalFile(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List files in a directory
 */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// =============================================================================
// S3 OPERATIONS
// =============================================================================

/**
 * Upload data to S3
 */
export async function uploadToS3(
  s3Key: string,
  data: Uint8Array | ArrayBuffer,
  contentType: string
): Promise<{ s3Key: string; s3Url: string } | null> {
  const client = getS3Client();
  if (!client) {
    logger.debug("S3 disabled, skipping upload");
    return null;
  }

  try {
    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);

    const s3File = client.file(s3Key, { type: contentType });
    await s3File.write(buffer);

    const s3Url = buildS3Url(s3Key);
    logger.debug(`Uploaded to S3: ${s3Key} (${buffer.length} bytes)`);

    return { s3Key, s3Url };
  } catch (error) {
    logger.error(`S3 upload failed for ${s3Key}: ${error}`);
    return null;
  }
}

/**
 * Upload a local file to S3
 */
export async function uploadFileToS3(
  localPath: string,
  s3Key: string,
  contentType: string
): Promise<{ s3Key: string; s3Url: string } | null> {
  try {
    const data = await readLocalFile(localPath);
    return await uploadToS3(s3Key, data, contentType);
  } catch (error) {
    logger.error(`Failed to read local file for S3 upload: ${error}`);
    return null;
  }
}

/**
 * Download data from S3
 */
export async function downloadFromS3(s3Key: string): Promise<Uint8Array | null> {
  const s3Url = buildS3Url(s3Key);

  try {
    const response = await fetch(s3Url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    logger.debug(`Downloaded from S3: ${s3Key} (${buffer.byteLength} bytes)`);

    return new Uint8Array(buffer);
  } catch (error) {
    logger.error(`S3 download failed for ${s3Key}: ${error}`);
    return null;
  }
}

/**
 * Download from S3 URL to local file
 */
export async function downloadFromS3ToFile(
  s3Url: string,
  localPath: string
): Promise<boolean> {
  try {
    const response = await fetch(s3Url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    await saveLocalFile(localPath, buffer);

    logger.debug(
      `Downloaded from S3 to file: ${s3Url} -> ${localPath} (${buffer.byteLength} bytes)`
    );
    return true;
  } catch (error) {
    logger.error(`Failed to download from S3 to file: ${error}`);
    return false;
  }
}

// =============================================================================
// CONTENT TYPES
// =============================================================================

export const CONTENT_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  json: "application/json",
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
} as const;

/**
 * Get content type for a file extension
 */
export function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return CONTENT_TYPES[ext as keyof typeof CONTENT_TYPES] || "application/octet-stream";
}

// =============================================================================
// SESSION STORAGE
// =============================================================================

/**
 * Get or create session directory
 */
export async function getOrCreateSessionDir(sessionId: string): Promise<string> {
  const dir = getSessionDir(sessionId);
  await ensureDir(dir);
  return dir;
}

/**
 * List all session directories
 */
export async function listSessionDirs(): Promise<string[]> {
  const storageDir = getStorageDir();
  const entries = await listFiles(storageDir);

  // Filter out hidden directories and non-session directories
  return entries.filter((entry) => !entry.startsWith("."));
}

/**
 * Delete all files for a session
 */
export async function deleteSessionFiles(sessionId: string): Promise<boolean> {
  const sessionDir = getSessionDir(sessionId);

  try {
    const { rm } = await import("fs/promises");
    await rm(sessionDir, { recursive: true, force: true });
    logger.info(`Deleted session files: ${sessionDir}`);
    return true;
  } catch (error) {
    logger.error(`Failed to delete session files: ${error}`);
    return false;
  }
}

/**
 * Delete all S3 files for a session using AWS SDK
 * Lists all objects with session prefixes and deletes them in bulk
 */
export async function deleteSessionS3Files(sessionId: string): Promise<{ success: boolean; deleted: number; errors: string[] }> {
  if (!config.s3.enabled) {
    logger.debug("S3 disabled, skipping S3 deletion");
    return { success: true, deleted: 0, errors: [] };
  }

  // Dynamically import AWS SDK
  const { S3Client: AwsS3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");

  // Ensure endpoint has protocol
  let endpoint = config.s3.endpoint;
  if (endpoint && !endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
    endpoint = `https://${endpoint}`;
  }

  const client = new AwsS3Client({
    region: config.s3.region,
    endpoint: endpoint,
    credentials: config.s3.credentials.accessKeyId ? {
      accessKeyId: config.s3.credentials.accessKeyId,
      secretAccessKey: config.s3.credentials.secretAccessKey,
    } : undefined,
  });

  const errors: string[] = [];
  let totalDeleted = 0;

  logger.info(`Deleting S3 files for session ${sessionId}`);

  // All prefixes where session files might exist
  const prefixes = [
    `${config.s3.prefix}${sessionId}/`,
    `${config.s3.hlsPrefix}${sessionId}/`,
    `${config.s3.peaksPrefix}${sessionId}/`,
  ];

  for (const prefix of prefixes) {
    try {
      // List all objects with this prefix
      let continuationToken: string | undefined;
      
      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: config.s3.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const listResponse = await client.send(listCommand);
        const objects = listResponse.Contents || [];

        if (objects.length > 0) {
          // Delete objects in batches of 1000 (S3 limit)
          const deleteCommand = new DeleteObjectsCommand({
            Bucket: config.s3.bucket,
            Delete: {
              Objects: objects.map(obj => ({ Key: obj.Key! })),
              Quiet: true,
            },
          });

          await client.send(deleteCommand);
          totalDeleted += objects.length;
          logger.debug(`Deleted ${objects.length} objects with prefix: ${prefix}`);
        }

        continuationToken = listResponse.NextContinuationToken;
      } while (continuationToken);

    } catch (error) {
      const msg = `Failed to delete S3 files with prefix ${prefix}: ${error}`;
      logger.error(msg);
      errors.push(msg);
    }
  }

  if (totalDeleted > 0) {
    logger.info(`Deleted ${totalDeleted} S3 files for session ${sessionId}`);
  } else {
    logger.info(`No S3 files found for session ${sessionId}`);
  }

  return { 
    success: errors.length === 0, 
    deleted: totalDeleted, 
    errors 
  };
}
