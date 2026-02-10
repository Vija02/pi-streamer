/**
 * Normalize Audio Step
 *
 * Applies peak normalization to the audio if configured and not a quiet channel.
 */
import { mkdir, unlink } from "fs/promises";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { applyVolumeGain } from "../../utils/ffmpeg";
import { getNormalizedChannelPath } from "../../utils/paths";
import { config } from "../../config";

export class NormalizeAudioStep extends BaseStep {
  name = "normalize-audio";
  description = "Apply peak normalization to audio";

  constructor() {
    super();
    this.init();
  }

  async shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean> {
    // Skip if normalization is disabled
    if (!config.processing.normalization.enabled) {
      this.logger.debug("Normalization disabled in config");
      return false;
    }

    // Skip if channel is quiet (don't amplify noise)
    if (data.isQuiet) {
      this.logger.debug("Skipping normalization for quiet channel");
      return false;
    }

    // Skip if we don't have audio stats
    if (!data.audioStats) {
      this.logger.debug("No audio stats available, skipping normalization");
      return false;
    }

    // Skip if gain would be negligible (less than 0.5dB)
    const targetPeak = config.processing.normalization.peakDb;
    const currentPeak = data.audioStats.maxVolume;
    const gain = targetPeak - currentPeak;

    if (Math.abs(gain) < 0.5) {
      this.logger.debug(`Gain too small (${gain.toFixed(2)}dB), skipping normalization`);
      return false;
    }

    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber, workDir } = ctx;

    if (!data.concatenatedPath) {
      return this.failure("No concatenated file. Run concatenate first.");
    }

    if (!data.audioStats) {
      return this.failure("No audio stats. Run analyze-audio first.");
    }

    const targetPeak = config.processing.normalization.peakDb;
    const currentPeak = data.audioStats.maxVolume;
    const gain = targetPeak - currentPeak;

    this.logger.info(
      `Normalizing channel ${channelNumber}: ${gain > 0 ? "+" : ""}${gain.toFixed(1)}dB ` +
        `(${currentPeak.toFixed(1)}dB -> ${targetPeak}dB)`
    );

    // Ensure work directory exists
    await mkdir(workDir, { recursive: true });

    const startTime = Date.now();

    try {
      const normalizedPath = getNormalizedChannelPath(sessionId, channelNumber);

      await applyVolumeGain(data.concatenatedPath, normalizedPath, gain);

      const durationMs = Date.now() - startTime;
      const file = Bun.file(normalizedPath);
      const fileSize = file.size;

      this.logger.info(
        `Normalized to ${normalizedPath} (${(fileSize / 1024 / 1024).toFixed(2)} MB) in ${durationMs}ms`
      );

      return this.success(
        { normalizedPath },
        { durationMs, gainDb: gain, bytesProcessed: fileSize }
      );
    } catch (error) {
      return this.logFailure(error, "Failed to normalize audio");
    }
  }

  async cleanup(ctx: StepContext, data: PipelineData): Promise<void> {
    // Clean up normalized file on failure
    if (data.normalizedPath) {
      await unlink(data.normalizedPath).catch(() => {});
    }
  }
}

export const normalizeAudioStep = new NormalizeAudioStep();
