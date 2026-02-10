/**
 * Encode MP3 Step
 *
 * Encodes the processed FLAC to MP3 with appropriate quality settings.
 * Uses VBR by default, with lower quality for quiet channels to save space.
 */
import { mkdir, unlink, stat } from "fs/promises";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { encodeToMp3, getAudioDuration } from "../../utils/ffmpeg";
import { getMp3Path } from "../../utils/paths";
import { config } from "../../config";

export class EncodeMp3Step extends BaseStep {
  name = "encode-mp3";
  description = "Encode audio to MP3 with appropriate quality";

  constructor() {
    super();
    this.init();
  }

  async shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean> {
    // Skip if we already have an MP3
    if (data.mp3Path) {
      const file = Bun.file(data.mp3Path);
      if (await file.exists()) {
        return false;
      }
    }
    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber, outputDir } = ctx;

    // Use normalized path if available, otherwise concatenated path
    const inputPath = data.normalizedPath || data.concatenatedPath;

    if (!inputPath) {
      return this.failure("No input file for encoding. Run concatenate or normalize first.");
    }

    // Determine encoding quality based on whether channel is quiet
    const isQuiet = data.isQuiet ?? false;
    const vbrQuality = isQuiet
      ? config.processing.mp3.quietChannelQuality
      : config.processing.mp3.vbrQuality;

    this.logger.info(
      `Encoding channel ${channelNumber} to MP3 ` +
        `(${config.processing.mp3.useVbr ? `VBR q${vbrQuality}` : `CBR ${config.processing.mp3.bitrate}`}` +
        `${isQuiet ? ", quiet channel" : ""})`
    );

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    const startTime = Date.now();

    try {
      const mp3Path = getMp3Path(sessionId, channelNumber);

      await encodeToMp3(inputPath, mp3Path, {
        useVbr: config.processing.mp3.useVbr,
        vbrQuality,
        bitrate: config.processing.mp3.bitrate,
      });

      // Get file size and duration
      const stats = await stat(mp3Path);
      const mp3FileSize = stats.size;
      const durationSeconds = await getAudioDuration(mp3Path);

      const durationMs = Date.now() - startTime;

      this.logger.info(
        `Encoded ${mp3Path} (${(mp3FileSize / 1024 / 1024).toFixed(2)} MB, ` +
          `${durationSeconds.toFixed(1)}s) in ${durationMs}ms`
      );

      return this.success(
        { mp3Path, mp3FileSize, durationSeconds },
        { durationMs, bytesProcessed: mp3FileSize, durationSeconds }
      );
    } catch (error) {
      return this.logFailure(error, "Failed to encode MP3");
    }
  }

  async cleanup(ctx: StepContext, data: PipelineData): Promise<void> {
    // Clean up MP3 file on failure
    if (data.mp3Path) {
      await unlink(data.mp3Path).catch(() => {});
    }
  }
}

export const encodeMp3Step = new EncodeMp3Step();
