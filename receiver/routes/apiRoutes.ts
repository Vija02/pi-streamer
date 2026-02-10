/**
 * API Routes
 *
 * Session listing and details endpoints.
 */
import { Hono } from "hono";
import { getAllSessions, getSession, getSessionStats } from "../db/sessions";
import { getProcessedChannels } from "../db/channels";
import {
  getRecording,
  getOrCreateRecording,
  updateRecording,
  parseTags,
  parseMetadata,
} from "../db/recordings";

const app = new Hono();

/**
 * GET /sessions - List all sessions
 */
app.get("/sessions", async (c) => {
  try {
    const sessions = getAllSessions();

    const sessionsWithStats = sessions.map((session) => {
      const stats = getSessionStats(session.id);
      return {
        ...session,
        ...stats,
      };
    });

    return c.json({ sessions: sessionsWithStats });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ sessions: [], error: message });
  }
});

/**
 * GET /sessions/:id - Get session details
 */
app.get("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const stats = getSessionStats(sessionId);
  const processedChannels = getProcessedChannels(sessionId);
  const recording = getRecording(sessionId);

  return c.json({
    session: {
      ...session,
      ...stats,
    },
    channels: processedChannels,
    recording: recording
      ? {
          ...recording,
          tags: parseTags(recording),
          metadata: parseMetadata(recording),
        }
      : null,
  });
});

/**
 * GET /sessions/:id/channels - Get channel URLs for a session
 */
app.get("/sessions/:id/channels", async (c) => {
  const sessionId = c.req.param("id");

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const channels = getProcessedChannels(sessionId);

  return c.json({
    sessionId,
    status: session.status,
    channels: channels.map((ch) => ({
      channelNumber: ch.channel_number,
      url: ch.s3_url,
      hlsUrl: ch.hls_url,
      peaksUrl: ch.peaks_url,
      localPath: ch.local_path,
      fileSize: ch.file_size,
      durationSeconds: ch.duration_seconds,
      isQuiet: ch.is_quiet === 1,
      isSilent: ch.is_silent === 1,
    })),
  });
});

/**
 * GET /sessions/:id/recording - Get recording metadata
 */
app.get("/sessions/:id/recording", async (c) => {
  const sessionId = c.req.param("id");

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const recording = getRecording(sessionId);
  if (!recording) {
    return c.json({ error: "Recording not found" }, 404);
  }

  return c.json({
    ...recording,
    tags: parseTags(recording),
    metadata: parseMetadata(recording),
  });
});

/**
 * PATCH /sessions/:id/recording - Update recording metadata
 */
app.patch("/sessions/:id/recording", async (c) => {
  const sessionId = c.req.param("id");

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const body = await c.req.json();

    // Ensure recording exists
    getOrCreateRecording(sessionId);

    // Update with provided fields
    const updated = updateRecording(sessionId, {
      title: body.title,
      description: body.description,
      recordedAt: body.recordedAt,
      location: body.location,
      tags: body.tags,
      metadata: body.metadata,
    });

    if (!updated) {
      return c.json({ error: "Failed to update recording" }, 500);
    }

    return c.json({
      success: true,
      recording: {
        ...updated,
        tags: parseTags(updated),
        metadata: parseMetadata(updated),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Invalid request body", message }, 400);
  }
});

export default app;
