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
import { deleteSessionFiles, deleteSessionS3Files } from "../services/storage";
import { deleteSession, getSession } from "../db/sessions";

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

/**
 * POST /delete - Delete a session completely (database, local files, S3)
 */
app.post("/delete", async (c) => {
  try {
    const body = await c.req.json();
    const sessionId = body.sessionId;

    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    // Check if session exists
    const session = getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    logger.info(`Deleting session: ${sessionId}`);

    const results = {
      localFiles: false,
      s3Files: { success: false, deleted: 0, errors: [] as string[] },
      database: false,
    };

    // 1. Delete local files
    results.localFiles = await deleteSessionFiles(sessionId);
    if (!results.localFiles) {
      logger.warn(`Failed to delete local files for session ${sessionId}`);
    }

    // 2. Delete S3 files
    results.s3Files = await deleteSessionS3Files(sessionId);
    if (!results.s3Files.success) {
      logger.warn(`Failed to delete some S3 files for session ${sessionId}: ${results.s3Files.errors.join(", ")}`);
    }

    // 3. Delete from database
    results.database = deleteSession(sessionId);
    if (!results.database) {
      logger.error(`Failed to delete session ${sessionId} from database`);
      return c.json({ 
        error: "Failed to delete session from database",
        results 
      }, 500);
    }

    logger.info(`Successfully deleted session: ${sessionId}`);

    return c.json({
      success: true,
      sessionId,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to delete session: ${message}`);
    return c.json({ error: "Failed to delete session", message }, 500);
  }
});

export default app;
