#!/usr/bin/env bun
/**
 * Upload Session Script
 *
 * Uploads all processed files (MP3, peaks, HLS) for a session to S3.
 * Useful when uploads fail and need to be retried.
 *
 * Usage: bun run scripts/upload-session.ts <sessionId>
 */

import { readdir } from "fs/promises";
import { join } from "path";
import {
  getMp3Dir,
  getPeaksDir,
  getHlsDir,
  getMp3S3Key,
  getPeaksS3Key,
  getHlsPlaylistS3Key,
  getHlsSegmentS3Key,
  buildS3Url,
} from "../utils/paths";
import {
  uploadFileToS3,
  localFileExists,
  CONTENT_TYPES,
  isS3Enabled,
} from "../services/storage";
import {
  getProcessedChannels,
  updateProcessedChannelS3,
  updateProcessedChannelHls,
  updateProcessedChannelPeaks,
} from "../db/channels";
import { getSession } from "../db/sessions";
import { config } from "../config";

// Simple console logger for CLI
const log = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  success: (msg: string) => console.log(`[SUCCESS] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
};

async function uploadSession(sessionId: string) {
  log.info(`Starting upload for session: ${sessionId}`);

  // Check if S3 is enabled
  if (!isS3Enabled()) {
    log.error("S3 is not enabled. Set S3_ENABLED=true and configure S3 credentials.");
    process.exit(1);
  }

  // Check if session exists
  const session = getSession(sessionId);
  if (!session) {
    log.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }

  log.info(`Session status: ${session.status}`);

  // Get processed channels
  const channels = getProcessedChannels(sessionId);
  if (channels.length === 0) {
    log.error(`No processed channels found for session: ${sessionId}`);
    process.exit(1);
  }

  log.info(`Found ${channels.length} channels to upload`);

  const mp3Dir = getMp3Dir(sessionId);
  const peaksDir = getPeaksDir(sessionId);
  const hlsDir = getHlsDir(sessionId);

  let successCount = 0;
  let errorCount = 0;

  for (const channel of channels) {
    const channelNum = channel.channel_number;
    const paddedChannel = String(channelNum).padStart(2, "0");
    log.info(`\n--- Channel ${channelNum} ---`);

    // Upload MP3
    const mp3Path = join(mp3Dir, `channel_${paddedChannel}.mp3`);
    if (await localFileExists(mp3Path)) {
      const mp3S3Key = getMp3S3Key(sessionId, channelNum);
      log.info(`Uploading MP3: ${mp3Path} -> ${mp3S3Key}`);
      const mp3Result = await uploadFileToS3(mp3Path, mp3S3Key, CONTENT_TYPES.mp3);
      if (mp3Result) {
        updateProcessedChannelS3(channel.id, mp3Result.s3Key, mp3Result.s3Url);
        log.success(`MP3 uploaded: ${mp3Result.s3Url}`);
        successCount++;
      } else {
        log.error(`Failed to upload MP3 for channel ${channelNum}`);
        errorCount++;
      }
    } else {
      log.warn(`MP3 not found: ${mp3Path}`);
    }

    // Upload peaks
    const peaksPath = join(peaksDir, `channel_${paddedChannel}_peaks.json`);
    if (await localFileExists(peaksPath)) {
      const peaksS3Key = getPeaksS3Key(sessionId, channelNum);
      log.info(`Uploading peaks: ${peaksPath} -> ${peaksS3Key}`);
      const peaksResult = await uploadFileToS3(peaksPath, peaksS3Key, CONTENT_TYPES.json);
      if (peaksResult) {
        updateProcessedChannelPeaks(channel.id, peaksResult.s3Url);
        log.success(`Peaks uploaded: ${peaksResult.s3Url}`);
        successCount++;
      } else {
        log.error(`Failed to upload peaks for channel ${channelNum}`);
        errorCount++;
      }
    } else {
      log.warn(`Peaks not found: ${peaksPath}`);
    }

    // Upload HLS files
    const hlsPlaylistPath = join(hlsDir, `channel_${paddedChannel}.m3u8`);
    if (await localFileExists(hlsPlaylistPath)) {
      // First upload all HLS segments
      const hlsFiles = await readdir(hlsDir);
      const segmentFiles = hlsFiles.filter(
        (f) => f.startsWith(`channel_${paddedChannel}_`) && f.endsWith(".ts")
      );

      log.info(`Uploading ${segmentFiles.length} HLS segments for channel ${channelNum}`);

      let segmentErrors = 0;
      for (const segmentFile of segmentFiles) {
        const segmentPath = join(hlsDir, segmentFile);
        const segmentS3Key = getHlsSegmentS3Key(sessionId, segmentFile);
        const segmentResult = await uploadFileToS3(segmentPath, segmentS3Key, CONTENT_TYPES.ts);
        if (!segmentResult) {
          log.error(`Failed to upload segment: ${segmentFile}`);
          segmentErrors++;
        }
      }

      if (segmentErrors > 0) {
        log.error(`${segmentErrors} HLS segments failed to upload for channel ${channelNum}`);
        errorCount++;
      } else {
        // Upload the playlist
        const playlistS3Key = getHlsPlaylistS3Key(sessionId, channelNum);
        log.info(`Uploading HLS playlist: ${hlsPlaylistPath} -> ${playlistS3Key}`);
        const playlistResult = await uploadFileToS3(
          hlsPlaylistPath,
          playlistS3Key,
          CONTENT_TYPES.m3u8
        );
        if (playlistResult) {
          updateProcessedChannelHls(channel.id, playlistResult.s3Url);
          log.success(`HLS uploaded: ${playlistResult.s3Url}`);
          successCount++;
        } else {
          log.error(`Failed to upload HLS playlist for channel ${channelNum}`);
          errorCount++;
        }
      }
    } else {
      log.warn(`HLS playlist not found: ${hlsPlaylistPath}`);
    }
  }

  log.info(`\n========================================`);
  log.info(`Upload complete for session: ${sessionId}`);
  log.info(`Successful uploads: ${successCount}`);
  log.info(`Failed uploads: ${errorCount}`);

  if (errorCount > 0) {
    process.exit(1);
  }
}

// Main
const sessionId = process.argv[2];

if (!sessionId) {
  console.log("Usage: bun run scripts/upload-session.ts <sessionId>");
  console.log("");
  console.log("Example: bun run scripts/upload-session.ts 20260327120000");
  process.exit(1);
}

uploadSession(sessionId).catch((err) => {
  log.error(`Unexpected error: ${err}`);
  process.exit(1);
});
