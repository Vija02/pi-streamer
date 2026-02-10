/**
 * Session Routes
 *
 * Handles session lifecycle operations.
 */
import { Hono } from "hono";
import { createLogger } from "../utils/logger";
import {
  markSessionComplete,
  triggerProcessing,
} from "../services/session";
import {
  regenerateHlsAndPeaks,
  regenerateAllMp3s,
  regenerateMp3ForChannel,
  regeneratePeaksForChannel,
} from "./helpers/regenerate";

const logger = createLogger("SessionRoutes");

const app = new Hono();

/**
 * POST /complete - Mark session as complete
 */
app.post("/complete", async (c) => {
  try {
    const body = await c.req.json();
    const sessionId = body.sessionId;

    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const success = markSessionComplete(sessionId);

    return c.json(
      {
        success,
        sessionId,
        message: success
          ? "Session marked as complete, processing queued"
          : "Session not found or not in receiving state",
      },
      success ? 200 : 400
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Invalid request body", message }, 400);
  }
});

/**
 * POST /process - Manually trigger processing
 */
app.post("/process", async (c) => {
  try {
    const body = await c.req.json();
    const sessionId = body.sessionId;

    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const success = await triggerProcessing(sessionId);

    return c.json(
      {
        success,
        sessionId,
        message: success
          ? "Processing triggered"
          : "Session not found or already processed/processing",
      },
      success ? 200 : 400
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Invalid request body", message }, 400);
  }
});

/**
 * POST /regenerate - Regenerate HLS and peaks for a processed session
 */
app.post("/regenerate", async (c) => {
  try {
    const body = await c.req.json();
    const sessionId = body.sessionId;

    if (!sessionId) {
      return c.json({ error: "Missing sessionId in request body" }, 400);
    }

    logger.info(`Regenerating HLS/peaks for session: ${sessionId}`);

    const result = await regenerateHlsAndPeaks(sessionId);

    return c.json(
      {
        success: result.success,
        sessionId,
        channelsProcessed: result.channelsProcessed,
        errors: result.errors,
      },
      result.success ? 200 : 400
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Failed to regenerate HLS/peaks", message }, 500);
  }
});

/**
 * POST /regenerate-mp3 - Regenerate all MP3s for a session
 */
app.post("/regenerate-mp3", async (c) => {
  try {
    const body = await c.req.json();
    const sessionId = body.sessionId;

    if (!sessionId) {
      return c.json({ error: "Missing sessionId in request body" }, 400);
    }

    logger.info(`Regenerating all MP3s for session: ${sessionId}`);

    const result = await regenerateAllMp3s(sessionId);

    return c.json(
      {
        success: result.success,
        sessionId,
        results: result.results,
      },
      result.success ? 200 : 400
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Failed to regenerate MP3s", message }, 500);
  }
});

/**
 * POST /regenerate-mp3-channel - Regenerate MP3 for a single channel
 */
app.post("/regenerate-mp3-channel", async (c) => {
  try {
    const body = await c.req.json();
    const { sessionId, channelNumber } = body;

    if (!sessionId) {
      return c.json({ error: "Missing sessionId in request body" }, 400);
    }

    if (typeof channelNumber !== "number" || channelNumber < 1 || channelNumber > 18) {
      return c.json({ error: "Invalid channelNumber (must be 1-18)" }, 400);
    }

    logger.info(`Regenerating MP3 for session ${sessionId}, channel ${channelNumber}`);

    const result = await regenerateMp3ForChannel(sessionId, channelNumber);

    return c.json(
      {
        success: result.success,
        sessionId,
        channelNumber,
        error: result.error,
      },
      result.success ? 200 : 400
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Failed to regenerate MP3", message }, 500);
  }
});

/**
 * POST /regenerate-peaks-channel - Regenerate peaks for a single channel
 */
app.post("/regenerate-peaks-channel", async (c) => {
  try {
    const body = await c.req.json();
    const { sessionId, channelNumber } = body;

    if (!sessionId) {
      return c.json({ error: "Missing sessionId in request body" }, 400);
    }

    if (typeof channelNumber !== "number" || channelNumber < 1 || channelNumber > 18) {
      return c.json({ error: "Invalid channelNumber (must be 1-18)" }, 400);
    }

    logger.info(`Regenerating peaks for session ${sessionId}, channel ${channelNumber}`);

    const result = await regeneratePeaksForChannel(sessionId, channelNumber);

    return c.json(
      {
        success: result.success,
        sessionId,
        channelNumber,
        peaksUrl: result.peaksUrl,
        error: result.error,
      },
      result.success ? 200 : 400
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Failed to regenerate peaks", message }, 500);
  }
});

export default app;
