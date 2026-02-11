/**
 * Generate HLS Step
 *
 * Generates HLS segments from the MP3 for streaming playback.
 */
import { mkdir, readdir, unlink } from "fs/promises";
import { join } from "path";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { generateHls } from "../../utils/ffmpeg";
import { getHlsDir, getHlsPlaylistPath, getHlsSegmentPattern } from "../../utils/paths";
import { config } from "../../config";

export class GenerateHlsStep extends BaseStep {
  name = "generate-hls";
  description = "Generate HLS segments for streaming playback";

  constructor() {
    super();
    this.init();
  }

  async shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean> {
    // Skip silent channels - no point generating HLS for silence
    if (data.isSilent) {
      this.logger.info(`Skipping HLS for silent channel ${ctx.channelNumber}`);
      return false;
    }

    // Skip if we already have HLS
    if (data.hlsPlaylistPath) {
      const file = Bun.file(data.hlsPlaylistPath);
      if (await file.exists()) {
        return false;
      }
    }
    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber } = ctx;

    if (!data.mp3Path) {
      return this.failure("No MP3 file. Run encode-mp3 first.");
    }

    this.logger.info(`Generating HLS for channel ${channelNumber}`);

    const startTime = Date.now();

    try {
      // Ensure HLS directory exists
      const hlsDir = getHlsDir(sessionId);
      await mkdir(hlsDir, { recursive: true });

      const hlsPlaylistPath = getHlsPlaylistPath(sessionId, channelNumber);
      const segmentPattern = getHlsSegmentPattern(sessionId, channelNumber);

      await generateHls(
        data.mp3Path,
        hlsPlaylistPath,
        segmentPattern,
        config.processing.hls.segmentDuration,
        config.processing.hls.audioBitrate
      );

      // Get list of generated segment files
      const padded = String(channelNumber).padStart(2, "0");
      const files = await readdir(hlsDir);
      const hlsSegmentPaths = files
        .filter((f) => f.startsWith(`channel_${padded}_`) && f.endsWith(".ts"))
        .map((f) => join(hlsDir, f));

      const durationMs = Date.now() - startTime;

      this.logger.info(
        `Generated HLS: ${hlsPlaylistPath} (${hlsSegmentPaths.length} segments) in ${durationMs}ms`
      );

      return this.success(
        { hlsPlaylistPath, hlsSegmentPaths },
        { durationMs, filesCreated: hlsSegmentPaths.length + 1 }
      );
    } catch (error) {
      return this.logFailure(error, "Failed to generate HLS");
    }
  }

  async cleanup(ctx: StepContext, data: PipelineData): Promise<void> {
    // Clean up HLS files on failure
    if (data.hlsPlaylistPath) {
      await unlink(data.hlsPlaylistPath).catch(() => {});
    }
    if (data.hlsSegmentPaths) {
      for (const path of data.hlsSegmentPaths) {
        await unlink(path).catch(() => {});
      }
    }
  }
}

export const generateHlsStep = new GenerateHlsStep();
