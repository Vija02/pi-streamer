/**
 * Recordings Database Operations
 *
 * Manages recording metadata and tags for processed sessions.
 */
import { getDatabase } from "./connection";
import type {
  Recording,
  RecordingSource,
  RecordingTags,
  RecordingMetadata,
} from "./types";

/**
 * Create a new recording record
 */
export function createRecording(
  sessionId: string,
  source: RecordingSource = "stream",
  title?: string,
  description?: string,
  recordedAt?: string,
  location?: string,
  tags?: RecordingTags,
  metadata?: RecordingMetadata
): Recording {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO recordings 
     (session_id, title, description, recorded_at, location, tags, metadata, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      title ?? null,
      description ?? null,
      recordedAt ?? null,
      location ?? null,
      tags ? JSON.stringify(tags) : null,
      metadata ? JSON.stringify(metadata) : null,
      source,
      now,
      now,
    ]
  );

  return getRecording(sessionId)!;
}

/**
 * Get a recording by session ID
 */
export function getRecording(sessionId: string): Recording | null {
  const db = getDatabase();
  return db
    .query<Recording, [string]>("SELECT * FROM recordings WHERE session_id = ?")
    .get(sessionId);
}

/**
 * Get or create a recording for a session
 */
export function getOrCreateRecording(
  sessionId: string,
  source: RecordingSource = "stream"
): Recording {
  const existing = getRecording(sessionId);
  if (existing) return existing;
  return createRecording(sessionId, source);
}

/**
 * Update a recording
 */
export function updateRecording(
  sessionId: string,
  updates: {
    title?: string | null;
    description?: string | null;
    recordedAt?: string | null;
    location?: string | null;
    tags?: RecordingTags | null;
    metadata?: RecordingMetadata | null;
  }
): Recording | null {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Get existing recording
  const existing = getRecording(sessionId);
  if (!existing) return null;

  // Build update query dynamically
  const fields: string[] = ["updated_at = ?"];
  const values: (string | null)[] = [now];

  if (updates.title !== undefined) {
    fields.push("title = ?");
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push("description = ?");
    values.push(updates.description);
  }
  if (updates.recordedAt !== undefined) {
    fields.push("recorded_at = ?");
    values.push(updates.recordedAt);
  }
  if (updates.location !== undefined) {
    fields.push("location = ?");
    values.push(updates.location);
  }
  if (updates.tags !== undefined) {
    fields.push("tags = ?");
    values.push(updates.tags ? JSON.stringify(updates.tags) : null);
  }
  if (updates.metadata !== undefined) {
    fields.push("metadata = ?");
    values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
  }

  values.push(sessionId);

  db.run(
    `UPDATE recordings SET ${fields.join(", ")} WHERE session_id = ?`,
    values
  );

  return getRecording(sessionId);
}

/**
 * Delete a recording
 */
export function deleteRecording(sessionId: string): boolean {
  const db = getDatabase();
  const result = db.run("DELETE FROM recordings WHERE session_id = ?", [sessionId]);
  return result.changes > 0;
}

/**
 * Get all recordings, ordered by creation date (newest first)
 */
export function getAllRecordings(): Recording[] {
  const db = getDatabase();
  return db
    .query<Recording, []>("SELECT * FROM recordings ORDER BY created_at DESC")
    .all();
}

/**
 * Get recordings by source type
 */
export function getRecordingsBySource(source: RecordingSource): Recording[] {
  const db = getDatabase();
  return db
    .query<Recording, [string]>(
      "SELECT * FROM recordings WHERE source = ? ORDER BY created_at DESC"
    )
    .all(source);
}

/**
 * Search recordings by title or description
 */
export function searchRecordings(query: string): Recording[] {
  const db = getDatabase();
  const searchTerm = `%${query}%`;
  return db
    .query<Recording, [string, string]>(
      `SELECT * FROM recordings 
       WHERE title LIKE ? OR description LIKE ?
       ORDER BY created_at DESC`
    )
    .all(searchTerm, searchTerm);
}

/**
 * Get recordings with a specific tag
 */
export function getRecordingsByTag(tag: string): Recording[] {
  const db = getDatabase();
  // SQLite JSON search - look for tag in the JSON array
  const searchPattern = `%"${tag}"%`;
  return db
    .query<Recording, [string]>(
      `SELECT * FROM recordings 
       WHERE tags LIKE ?
       ORDER BY created_at DESC`
    )
    .all(searchPattern);
}

/**
 * Get all unique tags across all recordings
 */
export function getAllTags(): string[] {
  const db = getDatabase();
  const recordings = db
    .query<{ tags: string | null }, []>(
      "SELECT DISTINCT tags FROM recordings WHERE tags IS NOT NULL"
    )
    .all();

  const tagSet = new Set<string>();
  for (const r of recordings) {
    if (r.tags) {
      try {
        const tags: string[] = JSON.parse(r.tags);
        for (const tag of tags) {
          tagSet.add(tag);
        }
      } catch {
        // Ignore invalid JSON
      }
    }
  }

  return Array.from(tagSet).sort();
}

/**
 * Add a tag to a recording
 */
export function addTag(sessionId: string, tag: string): Recording | null {
  const recording = getRecording(sessionId);
  if (!recording) return null;

  const currentTags = parseTags(recording);
  if (!currentTags.includes(tag)) {
    currentTags.push(tag);
    return updateRecording(sessionId, { tags: currentTags });
  }

  return recording;
}

/**
 * Remove a tag from a recording
 */
export function removeTag(sessionId: string, tag: string): Recording | null {
  const recording = getRecording(sessionId);
  if (!recording) return null;

  const currentTags = parseTags(recording);
  const index = currentTags.indexOf(tag);
  if (index > -1) {
    currentTags.splice(index, 1);
    return updateRecording(sessionId, { tags: currentTags });
  }

  return recording;
}

/**
 * Parse tags from a recording
 */
export function parseTags(recording: Recording): RecordingTags {
  if (!recording.tags) return [];
  try {
    return JSON.parse(recording.tags);
  } catch {
    return [];
  }
}

/**
 * Parse metadata from a recording
 */
export function parseMetadata(recording: Recording): RecordingMetadata {
  if (!recording.metadata) return {};
  try {
    return JSON.parse(recording.metadata);
  } catch {
    return {};
  }
}

/**
 * Update a single metadata field
 */
export function updateMetadataField(
  sessionId: string,
  key: string,
  value: unknown
): Recording | null {
  const recording = getRecording(sessionId);
  if (!recording) return null;

  const currentMetadata = parseMetadata(recording);
  currentMetadata[key] = value;

  return updateRecording(sessionId, { metadata: currentMetadata });
}

/**
 * Get recordings within a date range
 */
export function getRecordingsByDateRange(
  startDate: string,
  endDate: string
): Recording[] {
  const db = getDatabase();
  return db
    .query<Recording, [string, string]>(
      `SELECT * FROM recordings 
       WHERE recorded_at >= ? AND recorded_at <= ?
       ORDER BY recorded_at DESC`
    )
    .all(startDate, endDate);
}

/**
 * Get recordings count by source
 */
export function getRecordingsCountBySource(): { stream: number; upload: number } {
  const db = getDatabase();

  const streamCount = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM recordings WHERE source = 'stream'"
    )
    .get();

  const uploadCount = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM recordings WHERE source = 'upload'"
    )
    .get();

  return {
    stream: streamCount?.count ?? 0,
    upload: uploadCount?.count ?? 0,
  };
}
