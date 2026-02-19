/**
 * Channel Settings Routes
 *
 * Endpoints for managing per-session channel volume and mute settings.
 */
import { Hono } from "hono";
import { getSession } from "../db/sessions";
import {
  getChannelSettingsBySession,
  updateChannelSetting,
  bulkUpdateChannelSettings,
} from "../db/channelSettings";

const app = new Hono();

/**
 * GET /sessions/:id/channel-settings - Get all channel settings for a session
 */
app.get("/sessions/:id/channel-settings", async (c) => {
  const sessionId = c.req.param("id");

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const settings = getChannelSettingsBySession(sessionId);

  return c.json({
    sessionId,
    settings: settings.map((s) => ({
      channelNumber: s.channel_number,
      volume: s.volume,
      isMuted: s.is_muted === 1,
    })),
  });
});

/**
 * PATCH /sessions/:id/channel-settings/:channelNumber - Update a single channel setting
 */
app.patch("/sessions/:id/channel-settings/:channelNumber", async (c) => {
  const sessionId = c.req.param("id");
  const channelNumber = parseInt(c.req.param("channelNumber"), 10);

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  if (isNaN(channelNumber) || channelNumber < 1 || channelNumber > 18) {
    return c.json({ error: "Invalid channel number" }, 400);
  }

  try {
    const body = await c.req.json();

    const updated = updateChannelSetting(sessionId, channelNumber, {
      volume: body.volume,
      isMuted: body.isMuted,
    });

    return c.json({
      success: true,
      setting: {
        channelNumber: updated.channel_number,
        volume: updated.volume,
        isMuted: updated.is_muted === 1,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Invalid request body", message }, 400);
  }
});

/**
 * PUT /sessions/:id/channel-settings - Bulk update channel settings
 */
app.put("/sessions/:id/channel-settings", async (c) => {
  const sessionId = c.req.param("id");

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const body = await c.req.json();

    if (!Array.isArray(body.settings)) {
      return c.json({ error: "settings must be an array" }, 400);
    }

    const updated = bulkUpdateChannelSettings(
      sessionId,
      body.settings.map((s: { channelNumber: number; volume?: number; isMuted?: boolean }) => ({
        channelNumber: s.channelNumber,
        volume: s.volume,
        isMuted: s.isMuted,
      }))
    );

    return c.json({
      success: true,
      settings: updated.map((s) => ({
        channelNumber: s.channel_number,
        volume: s.volume,
        isMuted: s.is_muted === 1,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Invalid request body", message }, 400);
  }
});

export default app;
