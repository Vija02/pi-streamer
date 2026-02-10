/**
 * Path Utilities
 *
 * Centralized path generation for consistent file organization.
 */
import { join, resolve } from "path";
import { config } from "../config";

/**
 * Get the base storage directory
 */
export function getStorageDir(): string {
  return config.localStorage.dir;
}

/**
 * Get the session directory for a given session ID
 */
export function getSessionDir(sessionId: string): string {
  return join(getStorageDir(), sessionId);
}

/**
 * Get the MP3 output directory for a session
 */
export function getMp3Dir(sessionId: string): string {
  return join(getSessionDir(sessionId), "mp3");
}

/**
 * Get the HLS output directory for a session
 */
export function getHlsDir(sessionId: string): string {
  return join(getSessionDir(sessionId), "hls");
}

/**
 * Get the peaks output directory for a session
 */
export function getPeaksDir(sessionId: string): string {
  return join(getSessionDir(sessionId), "peaks");
}

/**
 * Get the temp directory for processing a session
 */
export function getTempDir(sessionId: string): string {
  return join(getSessionDir(sessionId), ".temp");
}

/**
 * Get the failed uploads directory
 */
export function getFailedUploadsDir(): string {
  return join(getStorageDir(), ".failed_uploads");
}

/**
 * Get the MP3 file path for a channel
 */
export function getMp3Path(sessionId: string, channelNumber: number): string {
  const padded = String(channelNumber).padStart(2, "0");
  return join(getMp3Dir(sessionId), `channel_${padded}.mp3`);
}

/**
 * Get the peaks JSON file path for a channel
 */
export function getPeaksPath(sessionId: string, channelNumber: number): string {
  const padded = String(channelNumber).padStart(2, "0");
  return join(getPeaksDir(sessionId), `channel_${padded}_peaks.json`);
}

/**
 * Get the HLS m3u8 playlist path for a channel
 */
export function getHlsPlaylistPath(sessionId: string, channelNumber: number): string {
  const padded = String(channelNumber).padStart(2, "0");
  return join(getHlsDir(sessionId), `channel_${padded}.m3u8`);
}

/**
 * Get the HLS segment pattern for a channel
 */
export function getHlsSegmentPattern(sessionId: string, channelNumber: number): string {
  const padded = String(channelNumber).padStart(2, "0");
  return join(getHlsDir(sessionId), `channel_${padded}_%03d.ts`);
}

/**
 * Get the FLAC segment path
 */
export function getFlacSegmentPath(
  sessionId: string,
  timestamp: string,
  segmentNumber: number | undefined,
  channelGroup: string | undefined,
  format: "wav" | "flac" = "flac"
): string {
  const segmentSuffix =
    segmentNumber !== undefined ? `_seg${String(segmentNumber).padStart(5, "0")}` : "";
  const channelSuffix = channelGroup ? `_${channelGroup}` : "";
  const filename = `${timestamp}${segmentSuffix}${channelSuffix}.${format}`;
  return join(getSessionDir(sessionId), filename);
}

/**
 * Generate S3 key for a raw segment
 */
export function getSegmentS3Key(
  sessionId: string,
  timestamp: string,
  segmentNumber: number | undefined,
  channelGroup: string | undefined,
  format: "wav" | "flac" = "flac"
): string {
  const segmentSuffix =
    segmentNumber !== undefined ? `_seg${String(segmentNumber).padStart(5, "0")}` : "";
  const channelSuffix = channelGroup ? `_${channelGroup}` : "";
  return `${config.s3.prefix}${sessionId}/${timestamp}${segmentSuffix}${channelSuffix}.${format}`;
}

/**
 * Generate S3 key for an MP3 file
 */
export function getMp3S3Key(sessionId: string, channelNumber: number): string {
  const padded = String(channelNumber).padStart(2, "0");
  return `${config.s3.prefix}${sessionId}/channel_${padded}.mp3`;
}

/**
 * Generate S3 key for peaks JSON
 */
export function getPeaksS3Key(sessionId: string, channelNumber: number): string {
  const padded = String(channelNumber).padStart(2, "0");
  return `${config.s3.peaksPrefix}${sessionId}/channel_${padded}_peaks.json`;
}

/**
 * Generate S3 key for HLS playlist
 */
export function getHlsPlaylistS3Key(sessionId: string, channelNumber: number): string {
  const padded = String(channelNumber).padStart(2, "0");
  return `${config.s3.hlsPrefix}${sessionId}/channel_${padded}.m3u8`;
}

/**
 * Generate S3 key for HLS segment
 */
export function getHlsSegmentS3Key(sessionId: string, segmentFilename: string): string {
  return `${config.s3.hlsPrefix}${sessionId}/${segmentFilename}`;
}

/**
 * Build public S3 URL from an S3 key
 */
export function buildS3Url(s3Key: string): string {
  const ensureProtocol = (url: string) =>
    url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;

  if (config.s3.publicUrl) {
    return `${ensureProtocol(config.s3.publicUrl)}/${s3Key}`;
  } else if (config.s3.endpoint) {
    return `${ensureProtocol(config.s3.endpoint)}/${config.s3.bucket}/${s3Key}`;
  }
  return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${s3Key}`;
}

/**
 * Create a concat file content for FFmpeg
 * Uses absolute paths to avoid resolution issues
 */
export function createConcatFileContent(filePaths: string[]): string {
  return filePaths.map((p) => `file '${resolve(p)}'`).join("\n");
}

/**
 * Get temp file path for processing
 */
export function getTempFilePath(sessionId: string, filename: string): string {
  return join(getTempDir(sessionId), filename);
}

/**
 * Get extracted channel temp file path
 */
export function getExtractedChannelPath(
  sessionId: string,
  segmentNumber: number,
  channelNumber: number
): string {
  return getTempFilePath(sessionId, `seg${segmentNumber}_ch${channelNumber}.flac`);
}

/**
 * Get concatenated channel temp file path
 */
export function getConcatenatedChannelPath(sessionId: string, channelNumber: number): string {
  return getTempFilePath(sessionId, `concat_ch${channelNumber}.flac`);
}

/**
 * Get normalized channel temp file path
 */
export function getNormalizedChannelPath(sessionId: string, channelNumber: number): string {
  return getTempFilePath(sessionId, `normalized_ch${channelNumber}.flac`);
}
