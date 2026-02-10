/**
 * Prefetch FLAC Step
 *
 * Downloads FLAC segments from S3 if they don't exist locally.
 * Groups segments by segment number and identifies which files contain the target channel.
 */
import { mkdir } from "fs/promises";
import { dirname } from "path";
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";
import type { Segment } from "../../db/types";
import { getSessionSegments, getSegmentsGroupedByNumber } from "../../db/segments";
import { getChannelIndexInGroup, findChannelGroup } from "../../utils/channelGroups";
import { buildS3Url } from "../../utils/paths";
import { config } from "../../config";

interface FlacInfo {
  segment: Segment;
  channelIndex: number;
  flacPath: string;
}

export class PrefetchFlacStep extends BaseStep {
  name = "prefetch-flac";
  description = "Download FLAC segments from S3 if not available locally";

  constructor() {
    super();
    this.init();
  }

  async execute(ctx: StepContext, data: PipelineData): Promise<StepResult> {
    const { sessionId, channelNumber } = ctx;

    this.logger.info(`Prefetching FLAC segments for channel ${channelNumber}`);

    try {
      // Get all segments for the session
      const segments = getSessionSegments(sessionId);
      if (segments.length === 0) {
        return this.failure("No segments found for session");
      }

      // Group segments by segment number
      const segmentsByNumber = getSegmentsGroupedByNumber(sessionId);

      // Find and fetch segments containing our channel
      const flacInfos = await this.prefetchSegments(
        channelNumber,
        segmentsByNumber
      );

      if (flacInfos.size === 0) {
        return this.failure(`No FLAC segments found for channel ${channelNumber}`);
      }

      // Extract just the segments and paths for pipeline data
      const orderedSegments = Array.from(flacInfos.values())
        .sort((a, b) => a.segment.segment_number - b.segment.segment_number)
        .map((info) => info.segment);

      this.logger.info(
        `Prefetched ${flacInfos.size} FLAC segments for channel ${channelNumber}`
      );

      return this.success({
        segments: orderedSegments,
        // Store flac info for extract step to use
        _flacInfos: Array.from(flacInfos.values()),
      });
    } catch (error) {
      return this.logFailure(error, "Failed to prefetch FLAC segments");
    }
  }

  private async prefetchSegments(
    channelNumber: number,
    segmentsByNumber: Map<number, Segment[]>
  ): Promise<Map<number, FlacInfo>> {
    const results = new Map<number, FlacInfo>();
    const concurrency = config.pipeline.flacDownloadConcurrency;

    // First, identify all segments we need
    const segmentsToProcess: Array<{
      segNum: number;
      segment: Segment;
      channelIndex: number;
    }> = [];

    for (const [segNum, segsForNumber] of segmentsByNumber) {
      // Find which segment file contains this channel
      for (const seg of segsForNumber) {
        const idx = getChannelIndexInGroup(channelNumber, seg.channel_group);
        if (idx >= 0) {
          segmentsToProcess.push({ segNum, segment: seg, channelIndex: idx });
          break;
        }
      }
    }

    if (segmentsToProcess.length === 0) {
      return results;
    }

    // Check which ones need downloading vs already exist locally
    const needsDownload: typeof segmentsToProcess = [];
    const alreadyLocal: typeof segmentsToProcess = [];

    await Promise.all(
      segmentsToProcess.map(async (item) => {
        const file = Bun.file(item.segment.local_path);
        if (await file.exists()) {
          alreadyLocal.push(item);
        } else if (item.segment.s3_key) {
          needsDownload.push(item);
        }
      })
    );

    // Add already-local segments to results
    for (const item of alreadyLocal) {
      results.set(item.segNum, {
        segment: item.segment,
        channelIndex: item.channelIndex,
        flacPath: item.segment.local_path,
      });
    }

    if (needsDownload.length > 0) {
      this.logger.info(
        `Downloading ${needsDownload.length} FLAC segments from S3 (concurrency: ${concurrency})...`
      );

      // Download in parallel with concurrency limit
      const batches: (typeof needsDownload)[] = [];
      for (let i = 0; i < needsDownload.length; i += concurrency) {
        batches.push(needsDownload.slice(i, i + concurrency));
      }

      for (const batch of batches) {
        const downloadResults = await Promise.allSettled(
          batch.map(async (item) => {
            const flacPath = await this.downloadFlac(item.segment);
            return { item, flacPath };
          })
        );

        for (const result of downloadResults) {
          if (result.status === "fulfilled" && result.value.flacPath) {
            const { item, flacPath } = result.value;
            results.set(item.segNum, {
              segment: item.segment,
              channelIndex: item.channelIndex,
              flacPath,
            });
          }
        }
      }

      this.logger.info(
        `Downloaded ${results.size - alreadyLocal.length} FLAC segments successfully`
      );
    }

    return results;
  }

  private async downloadFlac(segment: Segment): Promise<string | null> {
    if (!segment.s3_key) {
      this.logger.warn(`No S3 key for segment ${segment.id}`);
      return null;
    }

    const s3Url = buildS3Url(segment.s3_key);
    const localPath = segment.local_path;

    this.logger.debug(`Downloading FLAC from S3: ${s3Url} -> ${localPath}`);

    try {
      // Ensure directory exists
      await mkdir(dirname(localPath), { recursive: true });

      // Fetch from S3
      const response = await fetch(s3Url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.arrayBuffer();
      await Bun.write(localPath, new Uint8Array(data));

      this.logger.debug(
        `Downloaded FLAC: ${localPath} (${(data.byteLength / 1024 / 1024).toFixed(2)} MB)`
      );

      return localPath;
    } catch (error) {
      this.logger.error(`Failed to download FLAC from S3: ${error}`);
      return null;
    }
  }
}

export const prefetchFlacStep = new PrefetchFlacStep();
