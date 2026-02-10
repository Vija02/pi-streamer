/**
 * Upload Peaks Step
 *
 * Uploads the peaks JSON to S3.
 */
import { S3Client } from "bun";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { getPeaksS3Key, buildS3Url } from "../../utils/paths";
import { config } from "../../config";

export class UploadPeaksStep extends BaseStep {
  name = "upload-peaks";
  description = "Upload peaks JSON to S3";

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
      this.logger.debug("S3 disabled, skipping peaks upload");
      return false;
    }

    // Skip if no peaks file
    if (!data.peaksPath) {
      this.logger.debug("No peaks file, skipping upload");
      return false;
    }

    // Skip if already uploaded
    if (data.peaksS3Url) {
      return false;
    }

    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber } = ctx;

    if (!data.peaksPath) {
      return this.skip("No peaks file to upload");
    }

    if (!this.s3Client) {
      return this.failure("S3 client not initialized");
    }

    this.logger.info(`Uploading peaks for channel ${channelNumber} to S3`);

    const startTime = Date.now();

    try {
      const s3Key = getPeaksS3Key(sessionId, channelNumber);
      const fileData = await Bun.file(data.peaksPath).arrayBuffer();

      const s3File = this.s3Client.file(s3Key, {
        type: "application/json",
      });

      await s3File.write(new Uint8Array(fileData));

      const peaksS3Url = buildS3Url(s3Key);
      const durationMs = Date.now() - startTime;

      this.logger.info(
        `Uploaded peaks to ${s3Key} (${(fileData.byteLength / 1024).toFixed(1)} KB) in ${durationMs}ms`
      );

      return this.success({ peaksS3Url }, { durationMs, bytesProcessed: fileData.byteLength });
    } catch (error) {
      return this.logFailure(error, "Failed to upload peaks to S3");
    }
  }
}

export const uploadPeaksStep = new UploadPeaksStep();
