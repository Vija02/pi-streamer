/**
 * Generate Peaks Step
 *
 * Generates waveform peaks JSON using audiowaveform.
 * Normalizes the data to -1 to 1 range for WaveSurfer.js.
 */
import { mkdir, unlink } from "fs/promises";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { generatePeaks, checkAudiowaveform } from "../../utils/ffmpeg";
import { getPeaksPath } from "../../utils/paths";
import { config } from "../../config";

export class GeneratePeaksStep extends BaseStep {
  name = "generate-peaks";
  description = "Generate waveform peaks JSON for visualization";

  constructor() {
    super();
    this.init();
  }

  async shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean> {
    // Skip silent channels - no point generating peaks for silence
    if (data.isSilent) {
      this.logger.info(`Skipping peaks for silent channel ${ctx.channelNumber}`);
      return false;
    }

    // Check if audiowaveform is available
    const hasAudiowaveform = await checkAudiowaveform();
    if (!hasAudiowaveform) {
      this.logger.warn("audiowaveform not available, skipping peaks generation");
      return false;
    }

    // Skip if we already have peaks
    if (data.peaksPath) {
      const file = Bun.file(data.peaksPath);
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

    this.logger.info(`Generating peaks for channel ${channelNumber}`);

    const startTime = Date.now();

    try {
      const peaksPath = getPeaksPath(sessionId, channelNumber);

      // Ensure peaks directory exists
      const { dirname } = await import("path");
      await mkdir(dirname(peaksPath), { recursive: true });

      // Generate peaks using audiowaveform
      await generatePeaks(
        data.mp3Path,
        peaksPath,
        config.processing.peaks.pixelsPerSecond,
        config.processing.peaks.bits
      );

      // Normalize peaks data
      await this.normalizePeaksFile(peaksPath);

      const file = Bun.file(peaksPath);
      const fileSize = file.size;
      const durationMs = Date.now() - startTime;

      this.logger.info(
        `Generated peaks ${peaksPath} (${(fileSize / 1024).toFixed(1)} KB) in ${durationMs}ms`
      );

      return this.success({ peaksPath }, { durationMs, bytesProcessed: fileSize });
    } catch (error) {
      return this.logFailure(error, "Failed to generate peaks");
    }
  }

  /**
   * Normalize peaks file to -1 to 1 range
   * audiowaveform outputs values in the range of the bit depth (e.g., -128 to 127 for 8-bit)
   */
  private async normalizePeaksFile(filePath: string): Promise<void> {
    const content = await Bun.file(filePath).json();
    const data = content.data as number[];

    if (!data || data.length === 0) {
      this.logger.warn(`Peaks file has no data: ${filePath}`);
      return;
    }

    // Find max absolute value using loop to avoid stack overflow with large arrays
    let maxVal = 0;
    for (let i = 0; i < data.length; i++) {
      const absVal = Math.abs(data[i]);
      if (absVal > maxVal) {
        maxVal = absVal;
      }
    }

    if (maxVal === 0) {
      this.logger.warn(`Peaks data is all zeros: ${filePath}`);
      return;
    }

    // Normalize to -1 to 1 range, round to 2 decimals
    content.data = data.map((x: number) => Math.round((x / maxVal) * 100) / 100);

    await Bun.write(filePath, JSON.stringify(content));
    this.logger.debug(
      `Normalized peaks file: ${filePath} (${data.length} samples, max was ${maxVal})`
    );
  }

  async cleanup(ctx: StepContext, data: PipelineData): Promise<void> {
    // Clean up peaks file on failure
    if (data.peaksPath) {
      await unlink(data.peaksPath).catch(() => {});
    }
  }
}

export const generatePeaksStep = new GeneratePeaksStep();
