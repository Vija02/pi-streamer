/**
 * Concatenate Step
 *
 * Concatenates all extracted channel segments into a single FLAC file.
 */
import { mkdir, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { concatenateAudio } from "../../utils/ffmpeg";
import { createConcatFileContent, getConcatenatedChannelPath } from "../../utils/paths";

export class ConcatenateStep extends BaseStep {
  name = "concatenate";
  description = "Concatenate extracted channel segments into single file";

  constructor() {
    super();
    this.init();
  }

  async shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean> {
    // Skip if we already have a concatenated file
    if (data.concatenatedPath) {
      const file = Bun.file(data.concatenatedPath);
      if (await file.exists()) {
        return false;
      }
    }
    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber, workDir } = ctx;

    if (!data.extractedPaths || data.extractedPaths.length === 0) {
      return this.failure("No extracted paths. Run extract-channel first.");
    }

    this.logger.info(
      `Concatenating ${data.extractedPaths.length} segments for channel ${channelNumber}`
    );

    // Ensure work directory exists
    await mkdir(workDir, { recursive: true });

    const startTime = Date.now();

    try {
      // Create concat file for FFmpeg
      const concatFilePath = join(workDir, `concat_ch${channelNumber}.txt`);
      const concatContent = createConcatFileContent(data.extractedPaths);
      await writeFile(concatFilePath, concatContent);

      // Output path for concatenated file
      const concatenatedPath = getConcatenatedChannelPath(sessionId, channelNumber);

      // Concatenate using FFmpeg
      await concatenateAudio(concatFilePath, concatenatedPath, "flac");

      // Clean up concat file
      await unlink(concatFilePath).catch(() => {});

      const durationMs = Date.now() - startTime;
      const file = Bun.file(concatenatedPath);
      const fileSize = file.size;

      this.logger.info(
        `Concatenated to ${concatenatedPath} (${(fileSize / 1024 / 1024).toFixed(2)} MB) in ${durationMs}ms`
      );

      return this.success(
        { concatenatedPath },
        { durationMs, bytesProcessed: fileSize }
      );
    } catch (error) {
      return this.logFailure(error, "Failed to concatenate segments");
    }
  }

  async cleanup(ctx: StepContext, data: PipelineData): Promise<void> {
    // Clean up concatenated file on failure
    if (data.concatenatedPath) {
      await unlink(data.concatenatedPath).catch(() => {});
    }
  }
}

export const concatenateStep = new ConcatenateStep();
