/**
 * Processed Channel Database Operations
 */
import { getDatabase } from "./connection";
import type { ProcessedChannel } from "./types";

/**
 * Insert or replace a processed channel
 */
export function insertProcessedChannel(
  sessionId: string,
  channelNumber: number,
  localPath: string,
  fileSize: number,
  s3Key?: string,
  s3Url?: string,
  durationSeconds?: number,
  hlsUrl?: string,
  peaksUrl?: string,
  isQuiet?: boolean,
  isSilent?: boolean
): ProcessedChannel {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.run(
    `INSERT OR REPLACE INTO processed_channels 
     (session_id, channel_number, local_path, s3_key, s3_url, hls_url, peaks_url, file_size, duration_seconds, is_quiet, is_silent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      channelNumber,
      localPath,
      s3Key ?? null,
      s3Url ?? null,
      hlsUrl ?? null,
      peaksUrl ?? null,
      fileSize,
      durationSeconds ?? null,
      isQuiet ? 1 : 0,
      isSilent ? 1 : 0,
      now,
    ]
  );

  const channel = db
    .query<ProcessedChannel, [string, number]>(
      "SELECT * FROM processed_channels WHERE session_id = ? AND channel_number = ?"
    )
    .get(sessionId, channelNumber);

  return channel!;
}

/**
 * Get all processed channels for a session
 */
export function getProcessedChannels(sessionId: string): ProcessedChannel[] {
  const db = getDatabase();
  return db
    .query<ProcessedChannel, [string]>(
      `SELECT * FROM processed_channels 
       WHERE session_id = ? 
       ORDER BY channel_number ASC`
    )
    .all(sessionId);
}

/**
 * Get a specific processed channel
 */
export function getProcessedChannel(
  sessionId: string,
  channelNumber: number
): ProcessedChannel | null {
  const db = getDatabase();
  return db
    .query<ProcessedChannel, [string, number]>(
      "SELECT * FROM processed_channels WHERE session_id = ? AND channel_number = ?"
    )
    .get(sessionId, channelNumber);
}

/**
 * Update S3 information for a processed channel
 */
export function updateProcessedChannelS3(
  channelId: number,
  s3Key: string,
  s3Url: string
): void {
  const db = getDatabase();
  db.run("UPDATE processed_channels SET s3_key = ?, s3_url = ? WHERE id = ?", [
    s3Key,
    s3Url,
    channelId,
  ]);
}

/**
 * Update HLS and peaks URLs for a processed channel
 */
export function updateProcessedChannelHlsAndPeaks(
  channelId: number,
  hlsUrl: string | null,
  peaksUrl: string | null
): void {
  const db = getDatabase();
  db.run("UPDATE processed_channels SET hls_url = ?, peaks_url = ? WHERE id = ?", [
    hlsUrl,
    peaksUrl,
    channelId,
  ]);
}

/**
 * Update only HLS URL
 */
export function updateProcessedChannelHls(
  channelId: number,
  hlsUrl: string
): void {
  const db = getDatabase();
  db.run("UPDATE processed_channels SET hls_url = ? WHERE id = ?", [hlsUrl, channelId]);
}

/**
 * Update only peaks URL
 */
export function updateProcessedChannelPeaks(
  channelId: number,
  peaksUrl: string
): void {
  const db = getDatabase();
  db.run("UPDATE processed_channels SET peaks_url = ? WHERE id = ?", [
    peaksUrl,
    channelId,
  ]);
}

/**
 * Update quiet/silent flags
 */
export function updateProcessedChannelFlags(
  channelId: number,
  isQuiet: boolean,
  isSilent: boolean
): void {
  const db = getDatabase();
  db.run("UPDATE processed_channels SET is_quiet = ?, is_silent = ? WHERE id = ?", [
    isQuiet ? 1 : 0,
    isSilent ? 1 : 0,
    channelId,
  ]);
}

/**
 * Get count of processed channels for a session
 */
export function getProcessedChannelCount(sessionId: string): number {
  const db = getDatabase();
  const result = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM processed_channels WHERE session_id = ?"
    )
    .get(sessionId);
  return result?.count ?? 0;
}

/**
 * Get channels that are missing HLS or peaks
 */
export function getChannelsMissingMedia(sessionId: string): ProcessedChannel[] {
  const db = getDatabase();
  return db
    .query<ProcessedChannel, [string]>(
      `SELECT * FROM processed_channels 
       WHERE session_id = ? AND (hls_url IS NULL OR peaks_url IS NULL)
       ORDER BY channel_number ASC`
    )
    .all(sessionId);
}

/**
 * Get quiet channels for a session
 */
export function getQuietChannels(sessionId: string): ProcessedChannel[] {
  const db = getDatabase();
  return db
    .query<ProcessedChannel, [string]>(
      `SELECT * FROM processed_channels 
       WHERE session_id = ? AND is_quiet = 1
       ORDER BY channel_number ASC`
    )
    .all(sessionId);
}

/**
 * Get total duration for all channels in a session (uses first non-null)
 */
export function getSessionDuration(sessionId: string): number | null {
  const db = getDatabase();
  const result = db
    .query<{ duration: number | null }, [string]>(
      `SELECT duration_seconds as duration FROM processed_channels 
       WHERE session_id = ? AND duration_seconds IS NOT NULL
       LIMIT 1`
    )
    .get(sessionId);
  return result?.duration ?? null;
}
