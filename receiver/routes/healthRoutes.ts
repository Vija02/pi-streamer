/**
 * Health Routes
 *
 * Health check and status endpoints.
 */
import { Hono } from "hono";
import { checkFfmpeg, checkAudiowaveform } from "../utils/ffmpeg";
import { config } from "../config";
import { getUploadQueueStatus } from "../services/uploadQueue";
import { getSessionManagerStatus } from "../services/session";

const app = new Hono();

/**
 * GET / - Health check
 */
app.get("/", async (c) => {
  const [hasFfmpeg, hasAudiowaveform] = await Promise.all([
    checkFfmpeg(),
    checkAudiowaveform(),
  ]);

  const uploadQueueStatus = getUploadQueueStatus();
  const sessionManagerStatus = getSessionManagerStatus();

  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    config: {
      s3Enabled: config.s3.enabled,
      s3Bucket: config.s3.bucket,
      localStorageDir: config.localStorage.dir,
    },
    tools: {
      ffmpeg: hasFfmpeg,
      audiowaveform: hasAudiowaveform,
    },
    uploadQueue: uploadQueueStatus,
    sessionManager: sessionManagerStatus,
  });
});

export default app;
