/**
 * Annotations Database Operations
 *
 * Manages time marker annotations on recordings.
 */
import { getDatabase } from "./connection";
import type { Annotation } from "./types";

/**
 * Create a new annotation
 */
export function createAnnotation(
  sessionId: string,
  timeSeconds: number,
  label: string,
  color?: string
): Annotation {
  const db = getDatabase();
  const now = new Date().toISOString();

  const result = db.run(
    `INSERT INTO annotations 
     (session_id, time_seconds, label, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, timeSeconds, label, color ?? null, now, now]
  );

  return getAnnotation(result.lastInsertRowid as number)!;
}

/**
 * Get an annotation by ID
 */
export function getAnnotation(id: number): Annotation | null {
  const db = getDatabase();
  return db
    .query<Annotation, [number]>("SELECT * FROM annotations WHERE id = ?")
    .get(id);
}

/**
 * Get all annotations for a session, ordered by time
 */
export function getAnnotationsBySession(sessionId: string): Annotation[] {
  const db = getDatabase();
  return db
    .query<Annotation, [string]>(
      "SELECT * FROM annotations WHERE session_id = ? ORDER BY time_seconds ASC"
    )
    .all(sessionId);
}

/**
 * Update an annotation
 */
export function updateAnnotation(
  id: number,
  updates: {
    timeSeconds?: number;
    label?: string;
    color?: string | null;
  }
): Annotation | null {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = getAnnotation(id);
  if (!existing) return null;

  const fields: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [now];

  if (updates.timeSeconds !== undefined) {
    fields.push("time_seconds = ?");
    values.push(updates.timeSeconds);
  }
  if (updates.label !== undefined) {
    fields.push("label = ?");
    values.push(updates.label);
  }
  if (updates.color !== undefined) {
    fields.push("color = ?");
    values.push(updates.color);
  }

  values.push(id);

  db.run(`UPDATE annotations SET ${fields.join(", ")} WHERE id = ?`, values);

  return getAnnotation(id);
}

/**
 * Delete an annotation
 */
export function deleteAnnotation(id: number): boolean {
  const db = getDatabase();
  const result = db.run("DELETE FROM annotations WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Delete all annotations for a session
 */
export function deleteAnnotationsBySession(sessionId: string): number {
  const db = getDatabase();
  const result = db.run("DELETE FROM annotations WHERE session_id = ?", [
    sessionId,
  ]);
  return result.changes;
}
