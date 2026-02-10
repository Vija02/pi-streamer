/**
 * Regenerate Helpers
 *
 * Functions for regenerating HLS, peaks, and MP3s from existing files.
 */
import { mkdir } from "fs/promises";
import { createLogger } from "../../utils/logger";
import { getSession } from "../../db/sessions";
import { getProcessedChannels, updateProcessedChannelHlsAndPeaks } from "../../db/channels";
import { getSessionSegments } from "../../db/segments";
import { getMp3Dir, getPeaksDir, getHlsDir, getMp3Path } from "../../utils/paths";
import { downloadFromS3ToFile, localFileExists } from "../../services/storage";
import {
  processChannel,
  regenerateChannelMedia,
} from "../../pipeline/channelProcessor";

const logger = createLogger("Regenerate");

/**
 * Regenerate HLS and peaks for a processed session
 */
export async function regenerateHlsAndPeaks(sessionId: string): Promise<{
  success: boolean;
  channelsProcessed: number;
  errors: string[];
}> {
  logger.info(`Regenerating HLS and peaks for session: ${sessionId}`);

  const session = getSession(sessionId);
  if (!session) {
    return { success: false, channelsProcessed: 0, errors: ["Session not found"] };
  }

  if (session.status !== "processed") {
    return {
      success: false,
      channelsProcessed: 0,
      errors: ["Session must be in 'processed' status"],
    };
  }

  const channels = getProcessedChannels(sessionId);
  if (channels.length === 0) {
    return {
      success: false,
      channelsProcessed: 0,
      errors: ["No processed channels found"],
    };
  }

  // Ensure directories exist
  await mkdir(getMp3Dir(sessionId), { recursive: true });
  await mkdir(getPeaksDir(sessionId), { recursive: true });
  await mkdir(getHlsDir(sessionId), { recursive: true });

  const errors: string[] = [];
  let channelsProcessed = 0;

  for (const channel of channels) {
    const channelNumber = channel.channel_number;
    let mp3Path = channel.local_path;

    // Check if MP3 exists locally
    if (!(await localFileExists(mp3Path))) {
      // Try to download from S3 if we have a URL
      if (channel.s3_url) {
        try {
          mp3Path = getMp3Path(sessionId, channelNumber);
          await downloadFromS3ToFile(channel.s3_url, mp3Path);
        } catch (err) {
          errors.push(`Channel ${channelNumber}: Failed to download MP3 from S3 - ${err}`);
          continue;
        }
      } else {
        errors.push(
          `Channel ${channelNumber}: MP3 file not found locally and no S3 URL available`
        );
        continue;
      }
    }

    // Regenerate using channel processor
    const result = await regenerateChannelMedia(sessionId, channelNumber, mp3Path);

    if (result.success) {
      // Update database with new URLs
      if (result.hlsS3Url || result.peaksS3Url) {
        updateProcessedChannelHlsAndPeaks(
          channel.id,
          result.hlsS3Url || channel.hls_url,
          result.peaksS3Url || channel.peaks_url
        );
      }
      channelsProcessed++;
    } else {
      errors.push(`Channel ${channelNumber}: ${result.error}`);
    }
  }

  const success = errors.length === 0 || channelsProcessed > 0;
  logger.info(
    `Regeneration complete: ${channelsProcessed} channels updated, ${errors.length} errors`
  );

  return { success, channelsProcessed, errors };
}

/**
 * Regenerate MP3 for a single channel
 */
export async function regenerateMp3ForChannel(
  sessionId: string,
  channelNumber: number
): Promise<{ success: boolean; error?: string }> {
  logger.info(`Regenerating MP3 for session ${sessionId}, channel ${channelNumber}`);

  const session = getSession(sessionId);
  if (!session) {
    return { success: false, error: "Session not found" };
  }

  if (session.status !== "processed") {
    return { success: false, error: "Session must be in 'processed' status" };
  }

  // Get segments for this session
  const segments = getSessionSegments(sessionId);
  if (segments.length === 0) {
    return { success: false, error: "No segments found for session" };
  }

  // Process the channel from scratch
  const result = await processChannel(sessionId, channelNumber);

  if (result.success) {
    logger.info(`Regenerated MP3 for channel ${channelNumber}`);
    return { success: true };
  } else {
    return { success: false, error: result.error };
  }
}

/**
 * Regenerate all MP3s for a session
 */
export async function regenerateAllMp3s(sessionId: string): Promise<{
  success: boolean;
  results: Array<{ channel: number; success: boolean; error?: string }>;
}> {
  logger.info(`Regenerating all MP3s for session: ${sessionId}`);

  const session = getSession(sessionId);
  if (!session) {
    return {
      success: false,
      results: [{ channel: 0, success: false, error: "Session not found" }],
    };
  }

  const results: Array<{ channel: number; success: boolean; error?: string }> = [];

  for (let channelNumber = 1; channelNumber <= session.channels; channelNumber++) {
    const result = await regenerateMp3ForChannel(sessionId, channelNumber);
    results.push({
      channel: channelNumber,
      success: result.success,
      error: result.error,
    });
  }

  const successCount = results.filter((r) => r.success).length;
  const success = successCount > 0;

  logger.info(
    `Regeneration complete: ${successCount}/${results.length} channels succeeded`
  );

  return { success, results };
}

/**
 * Regenerate peaks for a single channel
 */
export async function regeneratePeaksForChannel(
  sessionId: string,
  channelNumber: number
): Promise<{ success: boolean; error?: string; peaksUrl?: string }> {
  logger.info(`Regenerating peaks for session ${sessionId}, channel ${channelNumber}`);

  const session = getSession(sessionId);
  if (!session) {
    return { success: false, error: "Session not found" };
  }

  if (session.status !== "processed") {
    return { success: false, error: "Session must be in 'processed' status" };
  }

  const channels = getProcessedChannels(sessionId);
  const channel = channels.find((c) => c.channel_number === channelNumber);
  if (!channel) {
    return { success: false, error: `Channel ${channelNumber} not found` };
  }

  let mp3Path = channel.local_path;

  // Check if MP3 exists locally
  if (!(await localFileExists(mp3Path))) {
    // Try to download from S3 if we have a URL
    if (channel.s3_url) {
      try {
        mp3Path = getMp3Path(sessionId, channelNumber);
        await downloadFromS3ToFile(channel.s3_url, mp3Path);
      } catch (err) {
        return { success: false, error: `Failed to download MP3 from S3: ${err}` };
      }
    } else {
      return {
        success: false,
        error: "MP3 file not found locally and no S3 URL available",
      };
    }
  }

  // Regenerate just peaks (not HLS)
  const result = await regenerateChannelMedia(sessionId, channelNumber, mp3Path);

  if (result.success && result.peaksS3Url) {
    updateProcessedChannelHlsAndPeaks(
      channel.id,
      channel.hls_url,
      result.peaksS3Url
    );
    return { success: true, peaksUrl: result.peaksS3Url };
  }

  return { success: false, error: result.error || "Failed to generate peaks" };
}
