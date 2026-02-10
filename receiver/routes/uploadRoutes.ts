/**
 * Upload Routes
 *
 * Handles single MP3 file uploads (for old recordings).
 */
import { Hono } from "hono";
import { mkdir, stat } from "fs/promises";
import { createLogger } from "../utils/logger";
import { upsertSession, updateSessionStatus } from "../db/sessions";
import { insertProcessedChannel } from "../db/channels";
import { createRecording } from "../db/recordings";
import { saveLocalFile, uploadFileToS3 } from "../services/storage";
import { getMp3Path, getMp3S3Key, getMp3Dir, getPeaksDir, getHlsDir } from "../utils/paths";
import { regenerateChannelMedia } from "../pipeline/channelProcessor";

const logger = createLogger("UploadRoutes");

const app = new Hono();

/**
 * POST / - Upload single MP3 file
 *
 * Creates a synthetic session for the upload, stores the MP3,
 * generates peaks and HLS, and creates recording metadata.
 */
app.post("/", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file provided" }, 400);
    }

    if (!file.name.endsWith(".mp3") && !file.type.includes("audio/mpeg")) {
      return c.json({ error: "Only MP3 files are supported" }, 400);
    }

    // Get optional metadata
    const title = formData.get("title")?.toString() || file.name.replace(".mp3", "");
    const description = formData.get("description")?.toString();
    const recordedAt = formData.get("recordedAt")?.toString();
    const location = formData.get("location")?.toString();
    const tagsString = formData.get("tags")?.toString();
    const channelNumber = parseInt(formData.get("channelNumber")?.toString() || "1", 10);

    // Parse tags (comma-separated or JSON array)
    let tags: string[] = [];
    if (tagsString) {
      try {
        tags = JSON.parse(tagsString);
      } catch {
        tags = tagsString.split(",").map((t) => t.trim()).filter(Boolean);
      }
    }

    // Generate session ID for this upload
    const sessionId = `upload_${Date.now()}`;

    logger.info(`Processing upload: ${file.name} as session ${sessionId}`);

    // Create session (synthetic - 1 channel)
    upsertSession(sessionId, 48000, 1);

    // Save the MP3 file
    const mp3Path = getMp3Path(sessionId, channelNumber);
    await mkdir(getMp3Dir(sessionId), { recursive: true });

    const fileBuffer = await file.arrayBuffer();
    await saveLocalFile(mp3Path, fileBuffer);

    logger.info(`Saved uploaded file: ${mp3Path} (${fileBuffer.byteLength} bytes)`);

    // Upload to S3
    const s3Key = getMp3S3Key(sessionId, channelNumber);
    const s3Result = await uploadFileToS3(mp3Path, s3Key, "audio/mpeg");

    // Generate peaks and HLS
    await mkdir(getPeaksDir(sessionId), { recursive: true });
    await mkdir(getHlsDir(sessionId), { recursive: true });

    const mediaResult = await regenerateChannelMedia(sessionId, channelNumber, mp3Path);

    // Get file stats
    const stats = await stat(mp3Path);

    // Save processed channel to database
    insertProcessedChannel(
      sessionId,
      channelNumber,
      mp3Path,
      stats.size,
      s3Result?.s3Key,
      s3Result?.s3Url,
      undefined, // duration - could get from ffprobe
      mediaResult.hlsS3Url,
      mediaResult.peaksS3Url,
      false, // isQuiet
      false // isSilent
    );

    // Mark session as processed
    updateSessionStatus(sessionId, "processed");

    // Create recording metadata
    const recording = createRecording(
      sessionId,
      "upload",
      title,
      description,
      recordedAt,
      location,
      tags.length > 0 ? tags : undefined
    );

    logger.info(`Upload complete: ${sessionId}`);

    return c.json({
      success: true,
      sessionId,
      recording: {
        id: recording.id,
        title: recording.title,
        tags,
      },
      channel: {
        channelNumber,
        mp3Url: s3Result?.s3Url,
        peaksUrl: mediaResult.peaksS3Url,
        hlsUrl: mediaResult.hlsS3Url,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Upload failed: ${message}`);
    return c.json({ error: "Upload failed", message }, 500);
  }
});

export default app;
