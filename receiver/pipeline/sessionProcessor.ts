/**
 * Session Processor
 *
 * Processes all channels for a session.
 */
import { createLogger } from "../utils/logger";
import { getSession, updateSessionStatus } from "../db/sessions";
import { getSessionSegments } from "../db/segments";
import { processChannel, cleanupTempFiles } from "./channelProcessor";
import type { PipelineOptions, SessionProcessorResult } from "./types";

const logger = createLogger("SessionProcessor");

/**
 * Process all channels for a session
 */
export async function processSession(
  sessionId: string,
  options: PipelineOptions = {}
): Promise<SessionProcessorResult> {
  logger.info(`Starting processing for session: ${sessionId}`);

  const startTime = Date.now();

  // Get session
  const session = getSession(sessionId);
  if (!session) {
    logger.error(`Session not found: ${sessionId}`);
    return {
      success: false,
      sessionId,
      channelResults: [],
      successfulChannels: 0,
      failedChannels: 0,
      totalDurationMs: 0,
      error: "Session not found",
    };
  }

  // Check session status
  if (session.status === "processing") {
    logger.warn(`Session ${sessionId} is already processing`);
    return {
      success: false,
      sessionId,
      channelResults: [],
      successfulChannels: 0,
      failedChannels: 0,
      totalDurationMs: 0,
      error: "Session is already processing",
    };
  }

  if (session.status === "processed") {
    logger.warn(`Session ${sessionId} is already processed`);
    return {
      success: false,
      sessionId,
      channelResults: [],
      successfulChannels: 0,
      failedChannels: 0,
      totalDurationMs: 0,
      error: "Session is already processed",
    };
  }

  // Get segments
  const segments = getSessionSegments(sessionId);
  if (segments.length === 0) {
    logger.error(`No segments found for session ${sessionId}`);
    updateSessionStatus(sessionId, "failed");
    return {
      success: false,
      sessionId,
      channelResults: [],
      successfulChannels: 0,
      failedChannels: 0,
      totalDurationMs: Date.now() - startTime,
      error: "No segments found for session",
    };
  }

  logger.info(`Found ${segments.length} segments for session ${sessionId}`);

  // Update status to processing
  updateSessionStatus(sessionId, "processing");

  // Process each channel
  const totalChannels = session.channels;
  const channelResults: SessionProcessorResult["channelResults"] = [];

  for (let channelNum = 1; channelNum <= totalChannels; channelNum++) {
    logger.info(
      `Processing channel ${channelNum}/${totalChannels} for session ${sessionId}`
    );

    try {
      const result = await processChannel(sessionId, channelNum, options);
      channelResults.push(result);

      if (result.success) {
        logger.info(`Channel ${channelNum} completed successfully`);
      } else {
        logger.error(`Channel ${channelNum} failed: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Channel ${channelNum} error: ${errorMessage}`);

      channelResults.push({
        success: false,
        channelNumber: channelNum,
        error: errorMessage,
      });
    }
  }

  // Clean up temp files
  await cleanupTempFiles(sessionId);

  // Calculate results
  const successfulChannels = channelResults.filter((r) => r.success).length;
  const failedChannels = channelResults.filter((r) => !r.success).length;
  const totalDurationMs = Date.now() - startTime;

  // Update session status
  if (failedChannels === 0) {
    updateSessionStatus(sessionId, "processed");
    logger.info(
      `Session ${sessionId} processed successfully in ${totalDurationMs}ms ` +
        `(${successfulChannels} channels)`
    );
  } else if (successfulChannels > 0) {
    // Partial success - some channels processed
    updateSessionStatus(sessionId, "processed");
    logger.warn(
      `Session ${sessionId} partially processed in ${totalDurationMs}ms ` +
        `(${successfulChannels} succeeded, ${failedChannels} failed)`
    );
  } else {
    // All channels failed
    updateSessionStatus(sessionId, "failed");
    logger.error(
      `Session ${sessionId} failed - all ${failedChannels} channels failed`
    );
  }

  return {
    success: failedChannels === 0,
    sessionId,
    channelResults,
    successfulChannels,
    failedChannels,
    totalDurationMs,
    error:
      failedChannels > 0
        ? `${failedChannels} channel(s) failed to process`
        : undefined,
  };
}

/**
 * Reprocess a single channel for an already processed session
 */
export async function reprocessChannel(
  sessionId: string,
  channelNumber: number,
  options: PipelineOptions = {}
): Promise<SessionProcessorResult["channelResults"][0]> {
  logger.info(
    `Reprocessing channel ${channelNumber} for session ${sessionId}`
  );

  const session = getSession(sessionId);
  if (!session) {
    return {
      success: false,
      channelNumber,
      error: "Session not found",
    };
  }

  if (channelNumber < 1 || channelNumber > session.channels) {
    return {
      success: false,
      channelNumber,
      error: `Invalid channel number (must be 1-${session.channels})`,
    };
  }

  return processChannel(sessionId, channelNumber, options);
}

/**
 * Process multiple sessions in sequence
 */
export async function processSessions(
  sessionIds: string[],
  options: PipelineOptions = {}
): Promise<Map<string, SessionProcessorResult>> {
  const results = new Map<string, SessionProcessorResult>();

  for (const sessionId of sessionIds) {
    logger.info(`Processing session ${sessionId} (${sessionIds.indexOf(sessionId) + 1}/${sessionIds.length})`);
    const result = await processSession(sessionId, options);
    results.set(sessionId, result);
  }

  return results;
}
