/**
 * Stream Routes
 *
 * Handles audio segment uploads from the sender.
 */
import { Hono } from "hono";
import { createLogger } from "../utils/logger";
import { config } from "../config";
import { upsertSession, touchSession } from "../db/sessions";
import { insertSegment } from "../db/segments";
import { saveLocalFile, getContentType } from "../services/storage";
import { addToUploadQueue } from "../services/uploadQueue";
import { getFlacSegmentPath, getSegmentS3Key } from "../utils/paths";
import {
  extractChannelGroupFromFilename,
  extractSegmentNumberFromFilename,
} from "../utils/channelGroups";

const logger = createLogger("StreamRoutes");

const app = new Hono();

/**
 * POST /stream - Upload audio segment
 */
app.post("/", async (c) => {
  const sessionId = c.req.header("x-session-id") || `session_${Date.now()}`;
  const segmentNumberHeader = c.req.header("x-segment-number");
  const sampleRate = Number(c.req.header("x-sample-rate")) || 48000;
  const channels = Number(c.req.header("x-channels")) || 18;
  const contentType = c.req.header("content-type") || "audio/wav";
  const format: "wav" | "flac" = contentType.includes("flac") ? "flac" : "wav";

  // Try to extract segment number from header
  let segmentNumber = segmentNumberHeader ? Number(segmentNumberHeader) : undefined;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  logger.info(
    `Receiving: session=${sessionId}, segment=${segmentNumber ?? "unknown"}, channels=${channels}`
  );

  try {
    // Read the entire body
    const data = new Uint8Array(await c.req.arrayBuffer());

    if (data.length === 0) {
      return c.json({ error: "Empty body" }, 400);
    }

    logger.debug(`Received ${data.length} bytes for session ${sessionId}`);

    // Upsert session in database
    upsertSession(sessionId, sampleRate, channels);

    // Determine channel group from header first, then fallback to content-disposition
    let channelGroup: string | undefined =
      c.req.header("x-channel-group") || undefined;

    // Fallback: try to extract from content-disposition header
    if (!channelGroup) {
      const contentDisposition = c.req.header("content-disposition");
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        if (filenameMatch) {
          channelGroup = extractChannelGroupFromFilename(filenameMatch[1]);
          if (segmentNumber === undefined) {
            segmentNumber = extractSegmentNumberFromFilename(filenameMatch[1]);
          }
        }
      }
    }

    // Step 1: Save locally FIRST (fast, reliable)
    const localPath = getFlacSegmentPath(
      sessionId,
      timestamp,
      segmentNumber,
      channelGroup,
      format
    );

    await saveLocalFile(localPath, data);
    logger.debug(`Saved locally: ${localPath} (${data.length} bytes)`);

    // Step 2: Record segment in database
    const segment = insertSegment(
      sessionId,
      segmentNumber ?? 0,
      channelGroup ?? "unknown",
      localPath,
      data.length
    );

    // Step 3: Touch session to update last activity time
    touchSession(sessionId);

    // Step 4: Queue for S3 upload (background, with retries)
    if (config.s3.enabled) {
      const s3Key = getSegmentS3Key(
        sessionId,
        timestamp,
        segmentNumber,
        channelGroup,
        format
      );

      addToUploadQueue(
        localPath,
        s3Key,
        getContentType(localPath),
        segment.id
      );
    }

    // Respond immediately after local save
    return c.json({
      success: true,
      sessionId,
      segmentNumber,
      channelGroup,
      size: data.length,
      localPath,
      s3Queued: config.s3.enabled,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error processing stream: ${message}`);
    return c.json(
      {
        error: "Failed to process stream",
        message,
      },
      500
    );
  }
});

export default app;
