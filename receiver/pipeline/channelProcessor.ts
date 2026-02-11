/**
 * Channel Processor
 *
 * Processes a single channel using the pipeline.
 */
import { mkdir, rm } from "fs/promises";
import { createLogger } from "../utils/logger";
import { getTempDir, getMp3Dir, getPeaksDir, getHlsDir } from "../utils/paths";
import { insertProcessedChannel, updateProcessedChannelS3 } from "../db/channels";
import { runPipeline } from "./runner";
import { defaultChannelPipeline, peaksAndHlsPipeline } from "./steps";
import type {
  StepContext,
  PipelineData,
  PipelineOptions,
  ChannelProcessorResult,
  PipelineStep,
} from "./types";

const logger = createLogger("ChannelProcessor");

/**
 * Process a single channel for a session
 */
export async function processChannel(
  sessionId: string,
  channelNumber: number,
  options: PipelineOptions = {}
): Promise<ChannelProcessorResult> {
  logger.info(`Processing channel ${channelNumber} for session ${sessionId}`);

  const startTime = Date.now();

  // Setup directories
  const workDir = getTempDir(sessionId);
  const outputDir = getMp3Dir(sessionId);

  try {
    // Ensure directories exist
    await mkdir(workDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await mkdir(getPeaksDir(sessionId), { recursive: true });
    await mkdir(getHlsDir(sessionId), { recursive: true });

    // Create step context
    const ctx: StepContext = {
      sessionId,
      channelNumber,
      workDir,
      outputDir,
    };

    // Run the pipeline
    const pipelineResult = await runPipeline(
      defaultChannelPipeline,
      ctx,
      {},
      options
    );

    // Extract results from pipeline data
    const { data } = pipelineResult;

    if (pipelineResult.success) {
      // Log pipeline data for debugging
      logger.debug(
        `Channel ${channelNumber} pipeline complete - isQuiet: ${data.isQuiet}, isSilent: ${data.isSilent}, ` +
        `skippedSteps: ${pipelineResult.skippedSteps?.join(", ") || "none"}`
      );

      // Save to database
      const channel = insertProcessedChannel(
        sessionId,
        channelNumber,
        data.mp3Path || "",
        data.mp3FileSize || 0,
        data.mp3S3Key,
        data.mp3S3Url,
        data.durationSeconds,
        data.hlsS3Url,
        data.peaksS3Url,
        data.isQuiet,
        data.isSilent
      );

      logger.info(
        `Channel ${channelNumber} processed successfully in ${Date.now() - startTime}ms`
      );

      return {
        success: true,
        channelNumber,
        mp3Path: data.mp3Path,
        mp3S3Url: data.mp3S3Url,
        peaksPath: data.peaksPath,
        peaksS3Url: data.peaksS3Url,
        hlsS3Url: data.hlsS3Url,
        durationSeconds: data.durationSeconds,
        fileSize: data.mp3FileSize,
        isQuiet: data.isQuiet,
        isSilent: data.isSilent,
        pipelineResult,
      };
    } else {
      logger.error(
        `Channel ${channelNumber} processing failed: ${pipelineResult.error}`
      );

      return {
        success: false,
        channelNumber,
        error: pipelineResult.error,
        pipelineResult,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Channel ${channelNumber} processing error: ${errorMessage}`);

    return {
      success: false,
      channelNumber,
      error: errorMessage,
    };
  }
}

/**
 * Regenerate peaks and HLS for a channel from existing MP3
 */
export async function regenerateChannelMedia(
  sessionId: string,
  channelNumber: number,
  mp3Path: string,
  options: PipelineOptions = {}
): Promise<ChannelProcessorResult> {
  logger.info(
    `Regenerating peaks and HLS for channel ${channelNumber}, session ${sessionId}`
  );

  const workDir = getTempDir(sessionId);
  const outputDir = getMp3Dir(sessionId);

  try {
    await mkdir(workDir, { recursive: true });
    await mkdir(getPeaksDir(sessionId), { recursive: true });
    await mkdir(getHlsDir(sessionId), { recursive: true });

    const ctx: StepContext = {
      sessionId,
      channelNumber,
      workDir,
      outputDir,
    };

    // Initial data with existing MP3 path
    const initialData: PipelineData = {
      mp3Path,
    };

    const pipelineResult = await runPipeline(
      peaksAndHlsPipeline,
      ctx,
      initialData,
      options
    );

    const { data } = pipelineResult;

    return {
      success: pipelineResult.success,
      channelNumber,
      mp3Path,
      peaksPath: data.peaksPath,
      peaksS3Url: data.peaksS3Url,
      hlsS3Url: data.hlsS3Url,
      error: pipelineResult.error,
      pipelineResult,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Regeneration error for channel ${channelNumber}: ${errorMessage}`);

    return {
      success: false,
      channelNumber,
      error: errorMessage,
    };
  }
}

/**
 * Process a channel with a custom pipeline
 */
export async function processChannelWithPipeline(
  sessionId: string,
  channelNumber: number,
  pipeline: PipelineStep[],
  initialData: PipelineData = {},
  options: PipelineOptions = {}
): Promise<ChannelProcessorResult> {
  logger.info(
    `Processing channel ${channelNumber} with custom pipeline (${pipeline.length} steps)`
  );

  const workDir = getTempDir(sessionId);
  const outputDir = getMp3Dir(sessionId);

  try {
    await mkdir(workDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const ctx: StepContext = {
      sessionId,
      channelNumber,
      workDir,
      outputDir,
    };

    const pipelineResult = await runPipeline(pipeline, ctx, initialData, options);
    const { data } = pipelineResult;

    return {
      success: pipelineResult.success,
      channelNumber,
      mp3Path: data.mp3Path,
      mp3S3Url: data.mp3S3Url,
      peaksPath: data.peaksPath,
      peaksS3Url: data.peaksS3Url,
      hlsS3Url: data.hlsS3Url,
      durationSeconds: data.durationSeconds,
      fileSize: data.mp3FileSize,
      isQuiet: data.isQuiet,
      isSilent: data.isSilent,
      error: pipelineResult.error,
      pipelineResult,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Custom pipeline error for channel ${channelNumber}: ${errorMessage}`);

    return {
      success: false,
      channelNumber,
      error: errorMessage,
    };
  }
}

/**
 * Clean up temp files for a session
 */
export async function cleanupTempFiles(sessionId: string): Promise<void> {
  const tempDir = getTempDir(sessionId);
  try {
    await rm(tempDir, { recursive: true, force: true });
    logger.debug(`Cleaned up temp directory: ${tempDir}`);
  } catch (error) {
    logger.warn(`Failed to clean up temp directory ${tempDir}: ${error}`);
  }
}
