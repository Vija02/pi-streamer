/**
 * Upload MP3 Step
 *
 * Uploads the encoded MP3 to S3.
 */
import { S3Client } from "bun";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { getMp3S3Key, buildS3Url } from "../../utils/paths";
import { config } from "../../config";

export class UploadMp3Step extends BaseStep {
  name = "upload-mp3";
  description = "Upload MP3 to S3";

  private s3Client: S3Client | null = null;

  constructor() {
    super();
    this.init();

    // Initialize S3 client if enabled
    if (config.s3.enabled) {
      this.s3Client = new S3Client({
        region: config.s3.region,
        endpoint: config.s3.endpoint,
        accessKeyId: config.s3.credentials.accessKeyId || undefined,
        secretAccessKey: config.s3.credentials.secretAccessKey || undefined,
        bucket: config.s3.bucket,
      });
    }
  }

  async shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean> {
    // Skip if S3 is disabled
    if (!config.s3.enabled || !this.s3Client) {
      this.logger.debug("S3 disabled, skipping MP3 upload");
      return false;
    }

    // Skip if already uploaded
    if (data.mp3S3Url) {
      return false;
    }

    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber } = ctx;

    if (!data.mp3Path) {
      return this.failure("No MP3 file. Run encode-mp3 first.");
    }

    if (!this.s3Client) {
      return this.failure("S3 client not initialized");
    }

    this.logger.info(`Uploading MP3 for channel ${channelNumber} to S3`);

    const startTime = Date.now();

    try {
      const mp3S3Key = getMp3S3Key(sessionId, channelNumber);
      const fileData = await Bun.file(data.mp3Path).arrayBuffer();

      const s3File = this.s3Client.file(mp3S3Key, {
        type: "audio/mpeg",
      });

      await s3File.write(new Uint8Array(fileData));

      const mp3S3Url = buildS3Url(mp3S3Key);
      const durationMs = Date.now() - startTime;

      this.logger.info(
        `Uploaded MP3 to ${mp3S3Key} (${(fileData.byteLength / 1024 / 1024).toFixed(2)} MB) in ${durationMs}ms`
      );

      return this.success(
        { mp3S3Key, mp3S3Url },
        { durationMs, bytesProcessed: fileData.byteLength }
      );
    } catch (error) {
      return this.logFailure(error, "Failed to upload MP3 to S3");
    }
  }
}

export const uploadMp3Step = new UploadMp3Step();
