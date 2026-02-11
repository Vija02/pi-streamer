/**
 * Routes Index
 *
 * Main Hono app with all routes registered.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "path";

import streamRoutes from "./streamRoutes";
import sessionRoutes from "./sessionRoutes";
import apiRoutes from "./apiRoutes";
import mediaRoutes from "./mediaRoutes";
import healthRoutes from "./healthRoutes";
import uploadRoutes from "./uploadRoutes";
import adminRoutes from "./adminRoutes";
import { retryFailedUploads } from "../services/uploadQueue";

const app = new Hono();

// =============================================================================
// MIDDLEWARE
// =============================================================================

// CORS middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS", "HEAD"],
    allowHeaders: [
      "Content-Type",
      "X-Session-ID",
      "X-Segment-Number",
      "X-Sample-Rate",
      "X-Channels",
      "X-Channel-Group",
      "Content-Disposition",
    ],
  })
);

// =============================================================================
// API ROUTES
// =============================================================================

// Stream uploads
app.route("/stream", streamRoutes);

// Session management
app.route("/session", sessionRoutes);

// Health check
app.route("/health", healthRoutes);

// API endpoints
app.route("/api", apiRoutes);

// Media endpoints (nested under /api)
app.route("/api", mediaRoutes);

// Upload endpoint
app.route("/api/upload", uploadRoutes);

// Admin endpoints
app.route("/api/admin", adminRoutes);

// Legacy sessions endpoint (for backward compatibility)
app.get("/sessions", async (c) => {
  // Redirect to new API endpoint
  return c.redirect("/api/sessions", 301);
});

// Retry failed uploads
app.post("/retry-failed", async (c) => {
  const retriedCount = await retryFailedUploads();
  return c.json({
    success: true,
    retriedCount,
  });
});

// =============================================================================
// STATIC FILE SERVING
// =============================================================================

const STATIC_DIR = "./web/dist";

// Serve static files from web/dist
app.use("/assets/*", serveStatic({ root: STATIC_DIR }));
app.use("/favicon.ico", serveStatic({ path: join(STATIC_DIR, "favicon.ico") }));

// SPA fallback - serve index.html for all non-API routes
app.get("*", async (c) => {
  const path = c.req.path;

  // Don't serve index.html for API routes
  // Note: /session is NOT excluded here because frontend uses /session/:id for SPA routing
  // The /session/* POST endpoints are already registered above and will match first
  if (
    path.startsWith("/api") ||
    path.startsWith("/stream") ||
    path.startsWith("/health") ||
    path.startsWith("/retry")
  ) {
    return c.json(
      {
        error: "Not Found",
        endpoints: {
          "POST /stream": "Upload audio segment",
          "POST /session/complete": "Mark session as complete",
          "POST /session/process": "Manually trigger processing",
          "POST /session/regenerate": "Regenerate HLS/peaks for a session",
          "POST /session/regenerate-mp3": "Regenerate all MP3s for a session",
          "POST /session/regenerate-mp3-channel": "Regenerate MP3 for a channel",
          "POST /session/regenerate-peaks-channel": "Regenerate peaks for a channel",
          "GET /health": "Health check & queue status",
          "GET /api/sessions": "List all sessions",
          "GET /api/sessions/:id": "Get session details",
          "GET /api/sessions/:id/channels": "Get channel URLs",
          "GET /api/sessions/:id/recording": "Get recording metadata",
          "PATCH /api/sessions/:id/recording": "Update recording metadata",
          "GET /api/sessions/:id/channels/:num/audio": "Stream MP3 file",
          "GET /api/sessions/:id/channels/:num/peaks": "Get peaks JSON",
          "GET /api/sessions/:id/channels/:num/hls/:file": "Stream HLS",
          "POST /api/upload": "Upload single MP3 file",
          "GET /api/admin/pipeline-runs": "List pipeline runs",
          "GET /api/admin/pipeline-runs/:sessionId": "Get session pipeline runs",
          "POST /api/admin/pipeline-runs/:runId/retry": "Retry failed step",
          "GET /api/admin/stats": "Processing statistics",
          "POST /retry-failed": "Retry failed S3 uploads",
        },
      },
      404
    );
  }

  // Serve index.html for SPA routes
  try {
    const indexPath = join(STATIC_DIR, "index.html");
    const file = Bun.file(indexPath);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "no-cache",
        },
      });
    }
  } catch {
    // Fall through to 404
  }

  return c.json({ error: "Not Found" }, 404);
});

export default app;
