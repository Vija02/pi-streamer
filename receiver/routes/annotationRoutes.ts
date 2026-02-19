/**
 * Annotation Routes
 *
 * CRUD endpoints for session annotations (time markers).
 */
import { Hono } from "hono";
import { getSession } from "../db/sessions";
import {
  createAnnotation,
  getAnnotationsBySession,
  getAnnotation,
  updateAnnotation,
  deleteAnnotation,
} from "../db/annotations";

const app = new Hono();

/**
 * GET /sessions/:id/annotations - Get all annotations for a session
 */
app.get("/sessions/:id/annotations", async (c) => {
  const sessionId = c.req.param("id");

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const annotations = getAnnotationsBySession(sessionId);

  return c.json({
    sessionId,
    annotations: annotations.map((a) => ({
      id: a.id,
      timeSeconds: a.time_seconds,
      label: a.label,
      color: a.color,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    })),
  });
});

/**
 * POST /sessions/:id/annotations - Create a new annotation
 */
app.post("/sessions/:id/annotations", async (c) => {
  const sessionId = c.req.param("id");

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const body = await c.req.json();

    if (typeof body.timeSeconds !== "number") {
      return c.json({ error: "timeSeconds is required and must be a number" }, 400);
    }
    if (typeof body.label !== "string" || body.label.trim() === "") {
      return c.json({ error: "label is required and must be a non-empty string" }, 400);
    }

    const annotation = createAnnotation(
      sessionId,
      body.timeSeconds,
      body.label.trim(),
      body.color
    );

    return c.json({
      success: true,
      annotation: {
        id: annotation.id,
        timeSeconds: annotation.time_seconds,
        label: annotation.label,
        color: annotation.color,
        createdAt: annotation.created_at,
        updatedAt: annotation.updated_at,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Invalid request body", message }, 400);
  }
});

/**
 * PATCH /sessions/:id/annotations/:annotationId - Update an annotation
 */
app.patch("/sessions/:id/annotations/:annotationId", async (c) => {
  const sessionId = c.req.param("id");
  const annotationId = parseInt(c.req.param("annotationId"), 10);

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const existing = getAnnotation(annotationId);
  if (!existing || existing.session_id !== sessionId) {
    return c.json({ error: "Annotation not found" }, 404);
  }

  try {
    const body = await c.req.json();

    const updated = updateAnnotation(annotationId, {
      timeSeconds: body.timeSeconds,
      label: body.label?.trim(),
      color: body.color,
    });

    if (!updated) {
      return c.json({ error: "Failed to update annotation" }, 500);
    }

    return c.json({
      success: true,
      annotation: {
        id: updated.id,
        timeSeconds: updated.time_seconds,
        label: updated.label,
        color: updated.color,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Invalid request body", message }, 400);
  }
});

/**
 * DELETE /sessions/:id/annotations/:annotationId - Delete an annotation
 */
app.delete("/sessions/:id/annotations/:annotationId", async (c) => {
  const sessionId = c.req.param("id");
  const annotationId = parseInt(c.req.param("annotationId"), 10);

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const existing = getAnnotation(annotationId);
  if (!existing || existing.session_id !== sessionId) {
    return c.json({ error: "Annotation not found" }, 404);
  }

  const deleted = deleteAnnotation(annotationId);
  if (!deleted) {
    return c.json({ error: "Failed to delete annotation" }, 500);
  }

  return c.json({ success: true });
});

export default app;
