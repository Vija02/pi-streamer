/**
 * Media Routes
 *
 * Serves audio files, peaks, and HLS streams.
 */
import { Hono } from "hono";
import { join } from "path";
import { readdir } from "fs/promises";
import { getProcessedChannels } from "../db/channels";
import { getMp3Path, getPeaksPath, getHlsDir } from "../utils/paths";

const app = new Hono();

/**
 * GET /sessions/:sessionId/channels/:channelNumber/audio - Stream MP3 file
 * Also supports HEAD for preload
 */
app.on(["GET", "HEAD"], "/sessions/:sessionId/channels/:channelNumber/audio", async (c) => {
  const sessionId = c.req.param("sessionId");
  const channelNumber = parseInt(c.req.param("channelNumber"), 10);

  const mp3Path = getMp3Path(sessionId, channelNumber);

  try {
    const file = Bun.file(mp3Path);
    if (!(await file.exists())) {
      return c.json({ error: "Audio file not found" }, 404);
    }

    return new Response(file, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `inline; filename="channel_${channelNumber}.mp3"`,
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    return c.json({ error: "Failed to serve audio" }, 500);
  }
});

/**
 * GET /sessions/:sessionId/channels/:channelNumber/peaks - Get peaks JSON
 */
app.get("/sessions/:sessionId/channels/:channelNumber/peaks", async (c) => {
  const sessionId = c.req.param("sessionId");
  const channelNumber = parseInt(c.req.param("channelNumber"), 10);

  const peaksPath = getPeaksPath(sessionId, channelNumber);

  try {
    const file = Bun.file(peaksPath);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=31536000", // Peaks are immutable
        },
      });
    }
  } catch {
    // Fall through to S3 redirect
  }

  // Fallback: redirect to S3 if local file doesn't exist
  const channels = getProcessedChannels(sessionId);
  const channel = channels.find((c) => c.channel_number === channelNumber);

  if (channel?.peaks_url) {
    return c.redirect(channel.peaks_url, 302);
  }

  return c.json({ error: "Peaks file not found" }, 404);
});

/**
 * GET /sessions/:sessionId/channels/:channelNumber/hls/:filename - Stream HLS files
 */
app.get("/sessions/:sessionId/channels/:channelNumber/hls/:filename", async (c) => {
  const sessionId = c.req.param("sessionId");
  const channelNumber = parseInt(c.req.param("channelNumber"), 10);
  const filename = c.req.param("filename");

  // Check if requesting m3u8 playlist - redirect to S3 if available
  if (filename.endsWith(".m3u8")) {
    const channels = getProcessedChannels(sessionId);
    const channel = channels.find((c) => c.channel_number === channelNumber);

    if (channel?.hls_url) {
      return c.redirect(channel.hls_url, 302);
    }
  }

  // Serve from local file
  const hlsDir = getHlsDir(sessionId);
  const hlsPath = join(hlsDir, filename);

  try {
    const file = Bun.file(hlsPath);
    if (!(await file.exists())) {
      return c.json({ error: "HLS file not found" }, 404);
    }

    const contentType = filename.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t";

    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": filename.endsWith(".m3u8")
          ? "no-cache" // Playlist can be updated
          : "public, max-age=31536000", // Segments are immutable
      },
    });
  } catch (error) {
    return c.json({ error: "Failed to serve HLS" }, 500);
  }
});

export default app;
