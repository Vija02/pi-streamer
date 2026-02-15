/**
 * Normalize Audio Step
 *
 * Applies LUFS-based loudness normalization to the audio if configured and not a quiet channel.
 * Uses FFmpeg's loudnorm filter for broadcast-standard loudness normalization.
 */
import { mkdir, unlink } from "fs/promises";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { applyLoudnessNormalization, applyHighGainNormalization } from "../../utils/ffmpeg";
import { getNormalizedChannelPath } from "../../utils/paths";
import { config } from "../../config";

export class NormalizeAudioStep extends BaseStep {
  name = "normalize-audio";
  description = "Apply LUFS-based loudness normalization to audio";

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

    // Skip if loudness is already close to target (within 1 LU)
    const targetLufs = config.processing.normalization.targetLufs;
    const currentLufs = data.audioStats.integratedLoudness;
    const lufsDiff = Math.abs(targetLufs - currentLufs);

    if (lufsDiff < 1) {
      this.logger.debug(`Loudness already at target (${currentLufs.toFixed(1)} LUFS, diff=${lufsDiff.toFixed(1)} LU), skipping normalization`);
      return false;
    }

    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber, workDir } = ctx;

    // Support both concatenated FLAC and uploaded MP3
    const inputPath = data.concatenatedPath || data.uploadedMp3Path;
    if (!inputPath) {
      return this.failure("No input file. Provide concatenatedPath or uploadedMp3Path.");
    }

    if (!data.audioStats) {
      return this.failure("No audio stats. Run analyze-audio first.");
    }

    const { targetLufs, targetTruePeak, targetLra } = config.processing.normalization;
    const { integratedLoudness } = data.audioStats;

    // Ensure work directory exists
    await mkdir(workDir, { recursive: true });

    const startTime = Date.now();

    try {
      const normalizedPath = getNormalizedChannelPath(sessionId, channelNumber);
      let result: { inputLufs: number; outputLufs: number };
      let normalizationMode: string;

      // Calculate required gain
      const gainNeeded = targetLufs - integratedLoudness;
      
      // Use gain-based normalization when required gain is large.
      // FFmpeg's loudnorm with dynamic mode limits gain to prevent amplifying silence/noise.
      // For audio that needs significant boost (>20dB), it typically fails to reach target.
      // In these cases, we use simple gain + limiter which properly amplifies the content.
      const highGainThreshold = config.processing.normalization.highGainThresholdDb;
      const useGainMode = gainNeeded > highGainThreshold;

      if (useGainMode) {
        this.logger.info(
          `Using gain-based normalization for channel ${channelNumber}: ` +
            `${gainNeeded.toFixed(1)}dB gain needed (> ${highGainThreshold}dB threshold). ` +
            `${integratedLoudness.toFixed(1)} LUFS -> ${targetLufs} LUFS`
        );

        // Apply simple gain + limiter to bring integrated loudness to target
        await applyHighGainNormalization(
          inputPath,
          normalizedPath,
          gainNeeded,
          targetTruePeak
        );

        result = { inputLufs: integratedLoudness, outputLufs: targetLufs };
        normalizationMode = "high-gain";
      } else {
        // Normal LUFS-based normalization for continuous audio with moderate gain
        this.logger.info(
          `Normalizing channel ${channelNumber}: ${integratedLoudness.toFixed(1)} LUFS -> ${targetLufs} LUFS ` +
            `(target TP: ${targetTruePeak}dB)`
        );

        result = await applyLoudnessNormalization(
          inputPath,
          normalizedPath,
          targetLufs,
          targetTruePeak,
          targetLra,
          data.audioStats.integratedLoudness,
          data.audioStats.truePeak,
          data.audioStats.loudnessRange
        );
        normalizationMode = "lufs";
      }

      const durationMs = Date.now() - startTime;
      const file = Bun.file(normalizedPath);
      const fileSize = file.size;

      this.logger.info(
        `Normalized to ${normalizedPath} (${(fileSize / 1024 / 1024).toFixed(2)} MB) in ${durationMs}ms ` +
          `[${result.inputLufs.toFixed(1)} -> ${result.outputLufs} LUFS, mode=${normalizationMode}]`
      );

      // After normalization, the audio is no longer silent - clear the flag
      // so that downstream steps (peaks, HLS) will process this channel
      return this.success(
        { 
          normalizedPath,
          isSilent: false,  // Audio is now audible after normalization
        },
        { 
          durationMs, 
          inputLufs: result.inputLufs, 
          outputLufs: result.outputLufs,
          bytesProcessed: fileSize,
          normalizationMode,
        }
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
