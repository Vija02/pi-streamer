/**
 * XR18 Audio Stream Receiver
 *
 * Receives 18-channel audio streams (WAV or FLAC) from the sender.
 *
 * Architecture:
 * 1. Receive audio data via HTTP POST
 * 2. Save locally FIRST (fast, reliable)
 * 3. Track in SQLite database
 * 4. Queue for S3 upload in background (decoupled, with retries)
 * 5. Process completed sessions (stitch channels, encode to MP3)
 *
 * This ensures:
 * - Fast response to sender (local write is quick)
 * - No data loss if S3 is slow/down
 * - Automatic retry of failed uploads
 * - Automatic processing after session timeout or explicit completion
 *
 * Requires Bun runtime for S3 operations and SQLite.
 */
import { S3Client } from "bun";
import {
  initDatabase,
  upsertSession,
  insertSegment,
  touchSession,
  getAllSessions,
  getSession,
  getSessionStats,
  getProcessedChannels,
  type Session,
} from "./db";
import {
  startSessionManager,
  stopSessionManager,
  getSessionManagerStatus,
  markSessionComplete,
  triggerProcessing,
} from "./session-manager";
import { checkFfmpeg } from "./processor";

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
  port: Number(process.env.PORT) || 3000,

  // S3 Configuration
  s3: {
    enabled: process.env.S3_ENABLED !== "false",
    bucket: process.env.S3_BUCKET || "your-audio-bucket",
    region: process.env.AWS_REGION || "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    endpoint: process.env.S3_ENDPOINT, // For S3-compatible services (R2, MinIO, etc.)
    prefix: process.env.S3_PREFIX || "recordings/", // Prefix for all uploads
  },

  // Local storage (primary - always enabled)
  localStorage: {
    dir: process.env.LOCAL_STORAGE_DIR || "./received",
  },

  // Upload queue settings
  uploadQueue: {
    retryIntervalMs: Number(process.env.UPLOAD_RETRY_INTERVAL) || 5000,
    maxRetries: Number(process.env.UPLOAD_MAX_RETRIES) || 5,
    concurrency: Number(process.env.UPLOAD_CONCURRENCY) || 2,
  },
};

// =============================================================================
// S3 CLIENT
// =============================================================================

const s3Client = config.s3.enabled
  ? new S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      accessKeyId: config.s3.accessKeyId || undefined,
      secretAccessKey: config.s3.secretAccessKey || undefined,
      bucket: config.s3.bucket,
    })
  : null;

// =============================================================================
// TYPES
// =============================================================================

interface StreamMetadata {
  sessionId: string;
  segmentNumber?: number;
  sampleRate: number;
  channels: number;
  timestamp: string;
  format: "wav" | "flac";
  channelGroup?: string; // e.g., "ch01-06"
}

interface UploadQueueItem {
  localPath: string;
  s3Key: string;
  metadata: StreamMetadata;
  retries: number;
  addedAt: number;
  segmentDbId?: number;
}

// =============================================================================
// UPLOAD QUEUE
// =============================================================================

const uploadQueue: UploadQueueItem[] = [];
let uploadQueueRunning = false;
let activeUploads = 0;

function log(message: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] ${message}`, ...args);
}

function generateS3Key(metadata: StreamMetadata): string {
  const { sessionId, segmentNumber, timestamp, format, channelGroup } = metadata;
  const segmentSuffix =
    segmentNumber !== undefined
      ? `_seg${String(segmentNumber).padStart(5, "0")}`
      : "";
  const channelSuffix = channelGroup ? `_${channelGroup}` : "";
  return `${config.s3.prefix}${sessionId}/${timestamp}${segmentSuffix}${channelSuffix}.${format}`;
}

async function ensureDir(dir: string) {
  const fs = await import("fs/promises");
  await fs.mkdir(dir, { recursive: true });
}

async function saveLocally(
  data: Uint8Array,
  metadata: StreamMetadata
): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");

  const sessionDir = path.join(config.localStorage.dir, metadata.sessionId);
  await ensureDir(sessionDir);

  const segmentSuffix =
    metadata.segmentNumber !== undefined
      ? `_seg${String(metadata.segmentNumber).padStart(5, "0")}`
      : "";
  const channelSuffix = metadata.channelGroup ? `_${metadata.channelGroup}` : "";
  const filename = `${metadata.timestamp}${segmentSuffix}${channelSuffix}.${metadata.format}`;
  const filepath = path.join(sessionDir, filename);

  await fs.writeFile(filepath, data);
  log(`Saved locally: ${filepath} (${data.length} bytes)`);

  return filepath;
}

async function uploadToS3(item: UploadQueueItem): Promise<boolean> {
  if (!s3Client) return false;

  const fs = await import("fs/promises");

  try {
    const data = await fs.readFile(item.localPath);

    // Use Bun's S3Client.file() to get an S3File reference and write to it
    const contentType =
      item.metadata.format === "wav" ? "audio/wav" : "audio/flac";
    const s3File = s3Client.file(item.s3Key, {
      type: contentType,
    });

    await s3File.write(data);

    log(
      `Uploaded to S3: s3://${config.s3.bucket}/${item.s3Key} (${data.length} bytes)`
    );
    return true;
  } catch (err) {
    log(`S3 upload failed for ${item.localPath}: ${err}`);
    return false;
  }
}

function addToUploadQueue(
  localPath: string,
  metadata: StreamMetadata,
  segmentDbId?: number
) {
  const s3Key = generateS3Key(metadata);

  uploadQueue.push({
    localPath,
    s3Key,
    metadata,
    retries: 0,
    addedAt: Date.now(),
    segmentDbId,
  });

  log(`Queued for upload: ${localPath} -> s3://${config.s3.bucket}/${s3Key}`);

  // Start queue processor if not running
  if (!uploadQueueRunning) {
    processUploadQueue();
  }
}

async function processUploadQueue() {
  if (uploadQueueRunning) return;
  uploadQueueRunning = true;

  log("Upload queue processor started");

  while (uploadQueue.length > 0 || activeUploads > 0) {
    // Process items up to concurrency limit
    while (
      activeUploads < config.uploadQueue.concurrency &&
      uploadQueue.length > 0
    ) {
      const item = uploadQueue.shift();
      if (!item) continue;

      activeUploads++;

      // Process upload (don't await, run concurrently)
      (async () => {
        const success = await uploadToS3(item);

        if (!success) {
          item.retries++;
          if (item.retries < config.uploadQueue.maxRetries) {
            log(
              `Will retry upload (${item.retries}/${config.uploadQueue.maxRetries}): ${item.localPath}`
            );
            // Add back to queue with delay
            setTimeout(() => {
              uploadQueue.push(item);
            }, config.uploadQueue.retryIntervalMs);
          } else {
            log(
              `Upload permanently failed after ${item.retries} retries: ${item.localPath}`
            );
            // Save failed upload info for manual retry later
            await saveFailedUploadInfo(item);
          }
        }

        activeUploads--;
      })();
    }

    // Wait before checking queue again
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  uploadQueueRunning = false;
  log("Upload queue processor stopped (queue empty)");
}

async function saveFailedUploadInfo(item: UploadQueueItem) {
  const fs = await import("fs/promises");
  const path = await import("path");

  const failedDir = path.join(config.localStorage.dir, ".failed_uploads");
  await ensureDir(failedDir);

  const filename = `${item.metadata.sessionId}_${item.metadata.timestamp}_seg${item.metadata.segmentNumber ?? 0}.json`;
  const filepath = path.join(failedDir, filename);

  await fs.writeFile(filepath, JSON.stringify(item, null, 2));
  log(`Saved failed upload info: ${filepath}`);
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Extract channel group from filename
 * e.g., "segment_00_ch01-06.flac" -> "ch01-06"
 */
function extractChannelGroup(filename: string): string | undefined {
  const match = filename.match(/(ch\d+-\d+)/);
  return match ? match[1] : undefined;
}

/**
 * Extract segment number from filename
 * e.g., "segment_00_ch01-06.flac" -> 0
 */
function extractSegmentNumber(filename: string): number | undefined {
  // Try segment_XX format first
  let match = filename.match(/segment_(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }

  // Try _segXXXXX format
  match = filename.match(/_seg(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }

  return undefined;
}

// =============================================================================
// REQUEST HANDLERS
// =============================================================================

async function handleStreamUpload(req: Request): Promise<Response> {
  const sessionId = req.headers.get("x-session-id") || `session_${Date.now()}`;
  const segmentNumberHeader = req.headers.get("x-segment-number");
  const sampleRate = Number(req.headers.get("x-sample-rate")) || 48000;
  const channels = Number(req.headers.get("x-channels")) || 18;
  const contentType = req.headers.get("content-type") || "audio/wav";
  const format: "wav" | "flac" = contentType.includes("flac") ? "flac" : "wav";

  // Try to extract segment number from header or we'll get it from filename later
  let segmentNumber = segmentNumberHeader ? Number(segmentNumberHeader) : undefined;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  log(
    `Receiving: session=${sessionId}, segment=${segmentNumber ?? "unknown"}, channels=${channels}`
  );

  try {
    // Read the entire body
    const data = new Uint8Array(await req.arrayBuffer());

    if (data.length === 0) {
      return new Response(JSON.stringify({ error: "Empty body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    log(`Received ${data.length} bytes for session ${sessionId}`);

    // Upsert session in database (creates if new, updates timestamp if exists)
    upsertSession(sessionId, sampleRate, channels);

    // Determine channel group from X-Channel-Group header first, then fallback to content-disposition
    let channelGroup: string | undefined = req.headers.get("x-channel-group") || undefined;

    // Fallback: try to extract from content-disposition header
    if (!channelGroup) {
      const contentDisposition = req.headers.get("content-disposition");
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        if (filenameMatch) {
          channelGroup = extractChannelGroup(filenameMatch[1]);
          if (segmentNumber === undefined) {
            segmentNumber = extractSegmentNumber(filenameMatch[1]);
          }
        }
      }
    }

    const metadata: StreamMetadata = {
      sessionId,
      segmentNumber,
      sampleRate,
      channels,
      timestamp,
      format,
      channelGroup,
    };

    // Step 1: Save locally FIRST (fast, reliable)
    const localPath = await saveLocally(data, metadata);

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
    if (config.s3.enabled && s3Client) {
      addToUploadQueue(localPath, metadata, segment.id);
    }

    // Respond immediately after local save
    return new Response(
      JSON.stringify({
        success: true,
        sessionId,
        segmentNumber: metadata.segmentNumber,
        channelGroup: metadata.channelGroup,
        size: data.length,
        localPath,
        s3Queued: config.s3.enabled,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    log(`Error processing stream: ${err}`);
    return new Response(
      JSON.stringify({
        error: "Failed to process stream",
        message: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

async function handleSessionComplete(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const sessionId = body.sessionId;

    if (!sessionId) {
      return new Response(
        JSON.stringify({ error: "sessionId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const success = markSessionComplete(sessionId);

    if (success) {
      return new Response(
        JSON.stringify({
          success: true,
          sessionId,
          message: "Session marked as complete, processing queued",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          sessionId,
          message: "Session not found or not in receiving state",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        message: err instanceof Error ? err.message : String(err),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function handleTriggerProcessing(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const sessionId = body.sessionId;

    if (!sessionId) {
      return new Response(
        JSON.stringify({ error: "sessionId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const success = await triggerProcessing(sessionId);

    if (success) {
      return new Response(
        JSON.stringify({
          success: true,
          sessionId,
          message: "Processing triggered",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          sessionId,
          message: "Session not found or already processed/processing",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        message: err instanceof Error ? err.message : String(err),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function handleHealthCheck(): Promise<Response> {
  const sessionManagerStatus = getSessionManagerStatus();

  return new Response(
    JSON.stringify({
      status: "ok",
      timestamp: new Date().toISOString(),
      config: {
        s3Enabled: config.s3.enabled,
        s3Bucket: config.s3.bucket,
        localStorageDir: config.localStorage.dir,
      },
      uploadQueue: {
        pending: uploadQueue.length,
        activeUploads,
        running: uploadQueueRunning,
      },
      sessionManager: sessionManagerStatus,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

async function handleListSessions(): Promise<Response> {
  try {
    const sessions = getAllSessions();

    const sessionsWithStats = sessions.map((session) => {
      const stats = getSessionStats(session.id);
      return {
        ...session,
        ...stats,
      };
    });

    return new Response(JSON.stringify({ sessions: sessionsWithStats }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ sessions: [], error: String(err) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleGetSession(sessionId: string): Promise<Response> {
  const session = getSession(sessionId);

  if (!session) {
    return new Response(
      JSON.stringify({ error: "Session not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  const stats = getSessionStats(sessionId);
  const processedChannels = getProcessedChannels(sessionId);

  return new Response(
    JSON.stringify({
      session: {
        ...session,
        ...stats,
      },
      channels: processedChannels,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function handleGetSessionChannels(sessionId: string): Promise<Response> {
  const session = getSession(sessionId);

  if (!session) {
    return new Response(
      JSON.stringify({ error: "Session not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  const channels = getProcessedChannels(sessionId);

  return new Response(
    JSON.stringify({
      sessionId,
      status: session.status,
      channels: channels.map((ch) => ({
        channelNumber: ch.channel_number,
        url: ch.s3_url,
        localPath: ch.local_path,
        fileSize: ch.file_size,
        durationSeconds: ch.duration_seconds,
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function handleServeAudio(sessionId: string, channelNumber: number): Promise<Response> {
  const path = await import("path");
  const fs = await import("fs/promises");

  // Find the MP3 file
  const mp3Path = path.join(
    config.localStorage.dir,
    sessionId,
    "mp3",
    `channel_${String(channelNumber).padStart(2, "0")}.mp3`
  );

  try {
    const file = Bun.file(mp3Path);
    if (!(await file.exists())) {
      return new Response(JSON.stringify({ error: "Audio file not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(file, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `inline; filename="channel_${channelNumber}.mp3"`,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Failed to serve audio" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleRetryFailed(): Promise<Response> {
  const fs = await import("fs/promises");
  const path = await import("path");

  const failedDir = path.join(config.localStorage.dir, ".failed_uploads");

  try {
    const files = await fs.readdir(failedDir);
    let retried = 0;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filepath = path.join(failedDir, file);
      const content = await fs.readFile(filepath, "utf-8");
      const item: UploadQueueItem = JSON.parse(content);

      // Reset retries and add back to queue
      item.retries = 0;
      uploadQueue.push(item);

      // Remove the failed file
      await fs.unlink(filepath);
      retried++;
    }

    // Start queue processor if not running
    if (retried > 0 && !uploadQueueRunning) {
      processUploadQueue();
    }

    return new Response(
      JSON.stringify({
        success: true,
        retriedCount: retried,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        success: true,
        retriedCount: 0,
        message: "No failed uploads to retry",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// =============================================================================
// STATIC FILE SERVING
// =============================================================================

const STATIC_DIR = "./web/dist";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveStaticFile(urlPath: string): Promise<Response | null> {
  const path = await import("path");

  // Default to index.html for root or paths without extension (SPA routing)
  let filePath = urlPath === "/" ? "/index.html" : urlPath;

  // For SPA routing: if path has no extension and doesn't start with /api, serve index.html
  const ext = path.extname(filePath);
  if (!ext && !urlPath.startsWith("/api") && !urlPath.startsWith("/stream") && 
      !urlPath.startsWith("/session") && !urlPath.startsWith("/health") && 
      !urlPath.startsWith("/retry")) {
    filePath = "/index.html";
  }

  const fullPath = path.join(STATIC_DIR, filePath);

  try {
    const file = Bun.file(fullPath);
    if (!(await file.exists())) {
      return null;
    }

    const mimeType = MIME_TYPES[ext] || "application/octet-stream";

    return new Response(file, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": ext === ".html" ? "no-cache" : "max-age=31536000",
      },
    });
  } catch {
    return null;
  }
}

// =============================================================================
// SERVER
// =============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Session-ID, X-Segment-Number, X-Sample-Rate, X-Channels, Content-Disposition",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let response: Response;

  try {
    // API routes
    if (path === "/stream" && method === "POST") {
      response = await handleStreamUpload(req);
    } else if (path === "/session/complete" && method === "POST") {
      response = await handleSessionComplete(req);
    } else if (path === "/session/process" && method === "POST") {
      response = await handleTriggerProcessing(req);
    } else if (path === "/health" && method === "GET") {
      response = await handleHealthCheck();
    } else if (path === "/api/sessions" && method === "GET") {
      response = await handleListSessions();
    } else if (path.match(/^\/api\/sessions\/[^/]+\/channels\/\d+\/audio$/) && (method === "GET" || method === "HEAD")) {
      // Serve audio file: /api/sessions/:sessionId/channels/:channelNumber/audio
      // This must come before the generic session routes!
      // Support both GET and HEAD (browsers send HEAD for audio preload)
      const parts = path.split("/");
      const sessionId = parts[3];
      const channelNumber = parseInt(parts[5], 10);
      response = await handleServeAudio(sessionId, channelNumber);
    } else if (path.startsWith("/api/sessions/") && path.endsWith("/channels") && method === "GET") {
      const sessionId = path.replace("/api/sessions/", "").replace("/channels", "");
      response = await handleGetSessionChannels(sessionId);
    } else if (path.startsWith("/api/sessions/") && method === "GET") {
      const sessionId = path.replace("/api/sessions/", "");
      response = await handleGetSession(sessionId);
    } else if (path === "/sessions" && method === "GET") {
      // Legacy endpoint
      response = await handleListSessions();
    } else if (path === "/retry-failed" && method === "POST") {
      response = await handleRetryFailed();
    } else {
      // Try to serve static files from web/dist
      const staticResponse = await serveStaticFile(path);
      if (staticResponse) {
        response = staticResponse;
      } else {
        response = new Response(
          JSON.stringify({
            error: "Not Found",
            endpoints: {
              "POST /stream": "Upload audio segment",
              "POST /session/complete": "Mark session as complete (triggers processing)",
              "POST /session/process": "Manually trigger processing for a session",
              "GET /health": "Health check & queue status",
              "GET /api/sessions": "List all sessions with stats",
              "GET /api/sessions/:id": "Get session details and processed channels",
              "GET /api/sessions/:id/channels": "Get channel MP3 URLs for a session",
              "GET /api/sessions/:id/channels/:num/audio": "Stream audio file",
              "POST /retry-failed": "Retry failed S3 uploads",
            },
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }
  } catch (err) {
    log(`Unhandled error: ${err}`);
    response = new Response(
      JSON.stringify({
        error: "Internal Server Error",
        message: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Add CORS headers to response
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  await ensureDir(config.localStorage.dir);

  // Initialize database
  initDatabase();

  // Check for ffmpeg
  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    log("WARNING: ffmpeg not found. Audio processing will fail.");
    log("Install with: sudo apt install ffmpeg");
  }

  log("XR18 Stream Receiver starting...");
  log(`  Port: ${config.port}`);
  log(`  Local Storage: ${config.localStorage.dir}`);
  log(`  S3 Enabled: ${config.s3.enabled}`);
  if (config.s3.enabled) {
    log(`  S3 Bucket: ${config.s3.bucket}`);
    log(`  S3 Prefix: ${config.s3.prefix}`);
  }
  log(`  FFmpeg: ${hasFfmpeg ? "available" : "NOT FOUND"}`);
  log("");

  // Check for required S3 config
  if (config.s3.enabled && !config.s3.accessKeyId && !process.env.AWS_PROFILE) {
    log("WARNING: S3 enabled but no AWS credentials configured.");
    log("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or use AWS_PROFILE");
    log("");
  }

  // Start session manager (handles timeout detection and processing)
  startSessionManager();

  // Handle graceful shutdown
  const shutdown = () => {
    log("Shutting down...");
    stopSessionManager();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Bun server
  if (typeof Bun !== "undefined") {
    Bun.serve({
      port: config.port,
      fetch: handleRequest,
    });
    log(`Server running at http://localhost:${config.port}`);
  } else {
    // Node.js fallback
    const http = await import("http");

    const server = http.createServer(async (req, res) => {
      // Convert Node.js request to Fetch API Request
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      const request = new Request(`http://localhost:${config.port}${req.url}`, {
        method: req.method,
        headers: req.headers as HeadersInit,
        body: ["GET", "HEAD"].includes(req.method!) ? undefined : body,
      });

      const response = await handleRequest(request);

      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const responseBody = await response.text();
      res.end(responseBody);
    });

    server.listen(config.port, () => {
      log(`Server running at http://localhost:${config.port}`);
    });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
