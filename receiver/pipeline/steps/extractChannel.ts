/**
 * Extract Channel Step
 *
 * Extracts a single channel from multi-channel FLAC files.
 * Produces one mono FLAC file per segment.
 */
import { mkdir } from "fs/promises";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { extractChannel } from "../../utils/ffmpeg";
import { getExtractedChannelPath } from "../../utils/paths";
import { getChannelIndexInGroup } from "../../utils/channelGroups";

interface FlacInfo {
  segment: { segment_number: number; local_path: string; channel_group: string };
  channelIndex: number;
  flacPath: string;
}

export class ExtractChannelStep extends BaseStep {
  name = "extract-channel";
  description = "Extract single channel from multi-channel FLAC files";

  constructor() {
    super();
    this.init();
  }

  async shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean> {
    // Skip if we already have extracted paths
    if (data.extractedPaths && data.extractedPaths.length > 0) {
      return false;
    }
    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber, workDir } = ctx;

    // Get flac infos from prefetch step
    const flacInfos = data._flacInfos as FlacInfo[] | undefined;
    if (!flacInfos || flacInfos.length === 0) {
      return this.failure("No FLAC info from prefetch step. Run prefetch-flac first.");
    }

    this.logger.info(
      `Extracting channel ${channelNumber} from ${flacInfos.length} segments`
    );

    // Ensure work directory exists
    await mkdir(workDir, { recursive: true });

    const extractedPaths: string[] = [];
    const startTime = Date.now();

    try {
      // Sort by segment number
      const sortedInfos = [...flacInfos].sort(
        (a, b) => a.segment.segment_number - b.segment.segment_number
      );

      for (const info of sortedInfos) {
        const outputPath = getExtractedChannelPath(
          sessionId,
          info.segment.segment_number,
          channelNumber
        );

        this.logger.debug(
          `Extracting channel ${channelNumber} (index ${info.channelIndex}) from segment ${info.segment.segment_number}`
        );

        await extractChannel(info.flacPath, info.channelIndex, outputPath);
        extractedPaths.push(outputPath);
      }

      const durationMs = Date.now() - startTime;
      this.logger.info(
        `Extracted ${extractedPaths.length} channel files in ${durationMs}ms`
      );

      return this.success(
        { extractedPaths },
        { durationMs, filesCreated: extractedPaths.length }
      );
    } catch (error) {
      return this.logFailure(error, "Failed to extract channel");
    }
  }

  async cleanup(ctx: StepContext, data: PipelineData): Promise<void> {
    // Clean up extracted files on failure
    if (data.extractedPaths) {
      for (const path of data.extractedPaths) {
        try {
          await Bun.file(path).exists() && (await Bun.write(path, ""));
          // Actually delete - Bun doesn't have a direct delete, use unlink
          const { unlink } = await import("fs/promises");
          await unlink(path).catch(() => {});
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}

export const extractChannelStep = new ExtractChannelStep();
