/**
 * Upload HLS Step
 *
 * Uploads HLS playlist and all segment files to S3.
 */
import { S3Client } from "bun";
import { basename } from "path";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import { getHlsPlaylistS3Key, getHlsSegmentS3Key, buildS3Url } from "../../utils/paths";
import { config } from "../../config";

export class UploadHlsStep extends BaseStep {
  name = "upload-hls";
  description = "Upload HLS playlist and segments to S3";

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
      this.logger.debug("S3 disabled, skipping HLS upload");
      return false;
    }

    // Skip if no HLS files
    if (!data.hlsPlaylistPath) {
      this.logger.debug("No HLS playlist, skipping upload");
      return false;
    }

    // Skip if already uploaded
    if (data.hlsS3Url) {
      return false;
    }

    return true;
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber } = ctx;

    if (!data.hlsPlaylistPath) {
      return this.skip("No HLS playlist to upload");
    }

    if (!this.s3Client) {
      return this.failure("S3 client not initialized");
    }

    const segmentCount = data.hlsSegmentPaths?.length ?? 0;
    this.logger.info(
      `Uploading HLS for channel ${channelNumber} to S3 (1 playlist + ${segmentCount} segments)`
    );

    const startTime = Date.now();
    let totalBytes = 0;

    try {
      // Upload playlist
      const playlistS3Key = getHlsPlaylistS3Key(sessionId, channelNumber);
      const playlistData = await Bun.file(data.hlsPlaylistPath).arrayBuffer();

      await this.s3Client
        .file(playlistS3Key, { type: "application/vnd.apple.mpegurl" })
        .write(new Uint8Array(playlistData));

      totalBytes += playlistData.byteLength;

      // Upload all segments with limited concurrency
      if (data.hlsSegmentPaths && data.hlsSegmentPaths.length > 0) {
        const CONCURRENCY_LIMIT = 10;
        const segments = data.hlsSegmentPaths;
        const totalSegments = segments.length;
        let uploadedCount = 0;
        let lastLoggedPercent = 0;

        this.logger.debug(
          `Uploading ${totalSegments} HLS segments (concurrency: ${CONCURRENCY_LIMIT})...`
        );

        for (let i = 0; i < segments.length; i += CONCURRENCY_LIMIT) {
          const batch = segments.slice(i, i + CONCURRENCY_LIMIT);
          const batchResults = await Promise.all(
            batch.map(async (segPath) => {
              const segName = basename(segPath);
              const segS3Key = getHlsSegmentS3Key(sessionId, segName);
              const segData = await Bun.file(segPath).arrayBuffer();

              await this.s3Client!
                .file(segS3Key, { type: "video/mp2t" })
                .write(new Uint8Array(segData));

              return segData.byteLength;
            })
          );

          totalBytes += batchResults.reduce((sum, bytes) => sum + bytes, 0);
          uploadedCount += batch.length;

          const percent = Math.floor((uploadedCount / totalSegments) * 100);
          if (percent >= lastLoggedPercent + 10) {
            lastLoggedPercent = Math.floor(percent / 10) * 10;
            this.logger.debug(`HLS upload progress: ${lastLoggedPercent}% (${uploadedCount}/${totalSegments})`);
          }
        }
      }

      const hlsS3Url = buildS3Url(playlistS3Key);
      const durationMs = Date.now() - startTime;

      this.logger.info(
        `Uploaded HLS to ${playlistS3Key} (${(totalBytes / 1024 / 1024).toFixed(2)} MB total) in ${durationMs}ms`
      );

      return this.success(
        { hlsS3Url },
        {
          durationMs,
          bytesProcessed: totalBytes,
          filesCreated: 1 + segmentCount,
        }
      );
    } catch (error) {
      return this.logFailure(error, "Failed to upload HLS to S3");
    }
  }
}

export const uploadHlsStep = new UploadHlsStep();
