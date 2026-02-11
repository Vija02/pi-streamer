/**
 * Upload Routes
 *
 * Handles single MP3 file uploads (for old recordings).
 * Uploaded files go through the same LUFS normalization pipeline as streamed recordings.
 */
import { Hono } from "hono";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createLogger } from "../utils/logger";
import { upsertSession, updateSessionStatus } from "../db/sessions";
import { insertProcessedChannel } from "../db/channels";
import { createRecording } from "../db/recordings";
import { saveLocalFile } from "../services/storage";
import { getMp3Dir, getPeaksDir, getHlsDir, getTempDir } from "../utils/paths";
import { processChannelWithPipeline } from "../pipeline/channelProcessor";
import { uploadedMp3Pipeline } from "../pipeline/steps";

const logger = createLogger("UploadRoutes");

const app = new Hono();

/**
 * POST / - Upload single MP3 file
 *
 * Creates a synthetic session for the upload, processes through the
 * normalization pipeline (analyze -> normalize -> encode -> peaks -> HLS -> upload),
 * and creates recording metadata.
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

    // Ensure directories exist
    await mkdir(getMp3Dir(sessionId), { recursive: true });
    await mkdir(getPeaksDir(sessionId), { recursive: true });
    await mkdir(getHlsDir(sessionId), { recursive: true });
    await mkdir(getTempDir(sessionId), { recursive: true });

    // Save uploaded file to temp directory for processing
    const uploadedMp3Path = join(getTempDir(sessionId), `uploaded_${channelNumber}.mp3`);
    const fileBuffer = await file.arrayBuffer();
    await saveLocalFile(uploadedMp3Path, fileBuffer);

    logger.info(`Saved uploaded file: ${uploadedMp3Path} (${fileBuffer.byteLength} bytes)`);

    // Process through the upload pipeline (analyze, normalize, encode, peaks, HLS, upload)
    const result = await processChannelWithPipeline(
      sessionId,
      channelNumber,
      uploadedMp3Pipeline,
      { uploadedMp3Path }
    );

    if (!result.success) {
      // Clean up on failure
      updateSessionStatus(sessionId, "failed");
      return c.json({ 
        error: "Processing failed", 
        message: result.error 
      }, 500);
    }

    // Save processed channel to database
    insertProcessedChannel(
      sessionId,
      channelNumber,
      result.mp3Path || uploadedMp3Path,
      result.fileSize || fileBuffer.byteLength,
      undefined, // s3Key - handled by pipeline
      result.mp3S3Url,
      result.durationSeconds,
      result.hlsS3Url,
      result.peaksS3Url,
      result.isQuiet,
      result.isSilent
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
        mp3Url: result.mp3S3Url,
        peaksUrl: result.peaksS3Url,
        hlsUrl: result.hlsS3Url,
        isQuiet: result.isQuiet,
        isSilent: result.isSilent,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Upload failed: ${message}`);
    return c.json({ error: "Upload failed", message }, 500);
  }
});

export default app;
