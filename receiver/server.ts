/**
 * XR18 Audio Stream Receiver
 *
 * Receives 18-channel audio streams (WAV or FLAC) from the sender.
 *
 * Architecture:
 * 1. Receive audio data via HTTP POST
 * 2. Save locally FIRST (fast, reliable)
 * 3. Queue for S3 upload in background (decoupled, with retries)
 *
 * This ensures:
 * - Fast response to sender (local write is quick)
 * - No data loss if S3 is slow/down
 * - Automatic retry of failed uploads
 *
 * Requires Bun runtime for S3 operations.
 */
import { S3Client } from "bun";

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
}

interface UploadQueueItem {
  localPath: string;
  s3Key: string;
  metadata: StreamMetadata;
  retries: number;
  addedAt: number;
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
  const { sessionId, segmentNumber, timestamp, format } = metadata;
  const segmentSuffix =
    segmentNumber !== undefined
      ? `_seg${String(segmentNumber).padStart(5, "0")}`
      : "";
  return `${config.s3.prefix}${sessionId}/${timestamp}${segmentSuffix}.${format}`;
}

async function ensureDir(dir: string) {
  const fs = await import("fs/promises");
  await fs.mkdir(dir, { recursive: true });
}

async function saveLocally(
  data: Uint8Array,
  metadata: StreamMetadata,
): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");

  const sessionDir = path.join(config.localStorage.dir, metadata.sessionId);
  await ensureDir(sessionDir);

  const segmentSuffix =
    metadata.segmentNumber !== undefined
      ? `_seg${String(metadata.segmentNumber).padStart(5, "0")}`
      : "";
  const filename = `${metadata.timestamp}${segmentSuffix}.${metadata.format}`;
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
    const contentType = item.metadata.format === "wav" ? "audio/wav" : "audio/flac";
    const s3File = s3Client.file(item.s3Key, {
      type: contentType,
    });

    await s3File.write(data);

    log(
      `Uploaded to S3: s3://${config.s3.bucket}/${item.s3Key} (${data.length} bytes)`,
    );
    return true;
  } catch (err) {
    log(`S3 upload failed for ${item.localPath}: ${err}`);
    return false;
  }
}

function addToUploadQueue(localPath: string, metadata: StreamMetadata) {
  const s3Key = generateS3Key(metadata);

  uploadQueue.push({
    localPath,
    s3Key,
    metadata,
    retries: 0,
    addedAt: Date.now(),
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
              `Will retry upload (${item.retries}/${config.uploadQueue.maxRetries}): ${item.localPath}`,
            );
            // Add back to queue with delay
            setTimeout(() => {
              uploadQueue.push(item);
            }, config.uploadQueue.retryIntervalMs);
          } else {
            log(
              `Upload permanently failed after ${item.retries} retries: ${item.localPath}`,
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
// REQUEST HANDLERS
// =============================================================================

async function handleStreamUpload(req: Request): Promise<Response> {
  const sessionId = req.headers.get("x-session-id") || `session_${Date.now()}`;
  const segmentNumber = req.headers.get("x-segment-number");
  const sampleRate = Number(req.headers.get("x-sample-rate")) || 48000;
  const channels = Number(req.headers.get("x-channels")) || 18;
  const contentType = req.headers.get("content-type") || "audio/wav";
  const format: "wav" | "flac" = contentType.includes("flac") ? "flac" : "wav";

  const metadata: StreamMetadata = {
    sessionId,
    segmentNumber: segmentNumber ? Number(segmentNumber) : undefined,
    sampleRate,
    channels,
    timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
    format,
  };

  log(
    `Receiving: session=${sessionId}, segment=${segmentNumber ?? "full"}, channels=${channels}`,
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

    // Step 1: Save locally FIRST (fast, reliable)
    const localPath = await saveLocally(data, metadata);

    // Step 2: Queue for S3 upload (background, with retries)
    if (config.s3.enabled && s3Client) {
      addToUploadQueue(localPath, metadata);
    }

    // Respond immediately after local save
    return new Response(
      JSON.stringify({
        success: true,
        sessionId,
        segmentNumber: metadata.segmentNumber,
        size: data.length,
        localPath,
        s3Queued: config.s3.enabled,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
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
      },
    );
  }
}

async function handleHealthCheck(): Promise<Response> {
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
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function handleListSessions(): Promise<Response> {
  const fs = await import("fs/promises");
  const path = await import("path");

  try {
    const entries = await fs.readdir(config.localStorage.dir, {
      withFileTypes: true,
    });
    const sessions: {
      sessionId: string;
      segmentCount: number;
      files: string[];
    }[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const sessionDir = path.join(config.localStorage.dir, entry.name);
        const files = await fs.readdir(sessionDir);
        const audioFiles = files.filter((f) => f.endsWith(".flac") || f.endsWith(".wav"));

        sessions.push({
          sessionId: entry.name,
          segmentCount: audioFiles.length,
          files: audioFiles,
        });
      }
    }

    return new Response(JSON.stringify({ sessions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
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
      },
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
      },
    );
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
      "Content-Type, X-Session-ID, X-Segment-Number, X-Sample-Rate, X-Channels",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let response: Response;

  try {
    if (path === "/stream" && method === "POST") {
      response = await handleStreamUpload(req);
    } else if (path === "/health" && method === "GET") {
      response = await handleHealthCheck();
    } else if (path === "/sessions" && method === "GET") {
      response = await handleListSessions();
    } else if (path === "/retry-failed" && method === "POST") {
      response = await handleRetryFailed();
    } else {
      response = new Response(
        JSON.stringify({
          error: "Not Found",
          endpoints: {
            "POST /stream": "Upload audio segment",
            "GET /health": "Health check & queue status",
            "GET /sessions": "List recorded sessions",
            "POST /retry-failed": "Retry failed S3 uploads",
          },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
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
      },
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

  log("XR18 Stream Receiver starting...");
  log(`  Port: ${config.port}`);
  log(`  Local Storage: ${config.localStorage.dir}`);
  log(`  S3 Enabled: ${config.s3.enabled}`);
  if (config.s3.enabled) {
    log(`  S3 Bucket: ${config.s3.bucket}`);
    log(`  S3 Prefix: ${config.s3.prefix}`);
  }
  log("");

  // Check for required S3 config
  if (config.s3.enabled && !config.s3.accessKeyId && !process.env.AWS_PROFILE) {
    log("WARNING: S3 enabled but no AWS credentials configured.");
    log("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or use AWS_PROFILE");
    log("");
  }

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
