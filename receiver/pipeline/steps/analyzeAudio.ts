/**
 * Analyze Audio Step
 *
 * Analyzes the concatenated audio to detect volume levels.
 * Determines if the channel is quiet or silent.
 */
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { analyzeAudio, type AudioStats } from "../../utils/ffmpeg";
import { config } from "../../config";

export class AnalyzeAudioStep extends BaseStep {
  name = "analyze-audio";
  description = "Analyze audio volume levels to detect quiet/silent channels";

  constructor() {
    super();
    this.init();
  }

  async shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean> {
    // Skip if we already have audio stats
    if (data.audioStats) {
      return false;
    }
    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { channelNumber } = ctx;

    // Determine which file to analyze
    const audioPath = data.concatenatedPath || data.extractedPaths?.[0];

    if (!audioPath) {
      return this.failure("No audio file to analyze. Run concatenate first.");
    }

    this.logger.info(`Analyzing audio for channel ${channelNumber}`);

    const startTime = Date.now();

    try {
      const audioStats = await analyzeAudio(
        audioPath,
        config.processing.analysis.quietThresholdDb
      );

      // Determine if silent (very low mean volume, below silence threshold)
      const isSilent = audioStats.meanVolume < config.processing.analysis.silenceThresholdDb;

      const durationMs = Date.now() - startTime;

      this.logger.info(
        `Channel ${channelNumber} analysis: max=${audioStats.maxVolume.toFixed(1)}dB, ` +
          `mean=${audioStats.meanVolume.toFixed(1)}dB, quiet=${audioStats.isQuiet}, silent=${isSilent}`
      );

      return this.success(
        {
          audioStats,
          isQuiet: audioStats.isQuiet,
          isSilent,
        },
        {
          durationMs,
          maxVolumeDb: audioStats.maxVolume,
          meanVolumeDb: audioStats.meanVolume,
        }
      );
    } catch (error) {
      return this.logFailure(error, "Failed to analyze audio");
    }
  }
}

export const analyzeAudioStep = new AnalyzeAudioStep();
