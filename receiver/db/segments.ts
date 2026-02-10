/**
 * Segment Database Operations
 */
import { getDatabase } from "./connection";
import type { Segment } from "./types";

/**
 * Insert or replace a segment
 */
export function insertSegment(
  sessionId: string,
  segmentNumber: number,
  channelGroup: string,
  localPath: string,
  fileSize: number,
  s3Key?: string
): Segment {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Use INSERT OR REPLACE to handle duplicates
  db.run(
    `INSERT OR REPLACE INTO segments 
     (session_id, segment_number, channel_group, local_path, s3_key, file_size, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, segmentNumber, channelGroup, localPath, s3Key ?? null, fileSize, now]
  );

  // Get the inserted/updated record
  const segment = db
    .query<Segment, [string, number, string]>(
      "SELECT * FROM segments WHERE session_id = ? AND segment_number = ? AND channel_group = ?"
    )
    .get(sessionId, segmentNumber, channelGroup);

  return segment!;
}

/**
 * Get all segments for a session, ordered by segment number
 */
export function getSessionSegments(sessionId: string): Segment[] {
  const db = getDatabase();
  return db
    .query<Segment, [string]>(
      `SELECT * FROM segments 
       WHERE session_id = ? 
       ORDER BY segment_number ASC, channel_group ASC`
    )
    .all(sessionId);
}

/**
 * Get segments by channel group
 */
export function getSegmentsByChannelGroup(
  sessionId: string,
  channelGroup: string
): Segment[] {
  const db = getDatabase();
  return db
    .query<Segment, [string, string]>(
      `SELECT * FROM segments 
       WHERE session_id = ? AND channel_group = ?
       ORDER BY segment_number ASC`
    )
    .all(sessionId, channelGroup);
}

/**
 * Update segment S3 key after upload
 */
export function updateSegmentS3Key(segmentId: number, s3Key: string): void {
  const db = getDatabase();
  db.run("UPDATE segments SET s3_key = ? WHERE id = ?", [s3Key, segmentId]);
}

/**
 * Get segment count for a session
 */
export function getSessionSegmentCount(sessionId: string): number {
  const db = getDatabase();
  const result = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM segments WHERE session_id = ?"
    )
    .get(sessionId);
  return result?.count ?? 0;
}

/**
 * Get a segment by ID
 */
export function getSegment(segmentId: number): Segment | null {
  const db = getDatabase();
  return db
    .query<Segment, [number]>("SELECT * FROM segments WHERE id = ?")
    .get(segmentId);
}

/**
 * Get segments that don't have S3 keys yet (pending upload)
 */
export function getSegmentsPendingUpload(sessionId: string): Segment[] {
  const db = getDatabase();
  return db
    .query<Segment, [string]>(
      `SELECT * FROM segments 
       WHERE session_id = ? AND s3_key IS NULL
       ORDER BY segment_number ASC`
    )
    .all(sessionId);
}

/**
 * Get distinct channel groups for a session
 */
export function getSessionChannelGroups(sessionId: string): string[] {
  const db = getDatabase();
  return db
    .query<{ channel_group: string }, [string]>(
      `SELECT DISTINCT channel_group FROM segments WHERE session_id = ? ORDER BY channel_group`
    )
    .all(sessionId)
    .map((r) => r.channel_group);
}

/**
 * Get segments grouped by segment number
 * Returns a map of segment_number -> segments[]
 */
export function getSegmentsGroupedByNumber(
  sessionId: string
): Map<number, Segment[]> {
  const segments = getSessionSegments(sessionId);
  const grouped = new Map<number, Segment[]>();

  for (const segment of segments) {
    const existing = grouped.get(segment.segment_number) || [];
    existing.push(segment);
    grouped.set(segment.segment_number, existing);
  }

  return grouped;
}

/**
 * Get the max segment number for a session
 */
export function getMaxSegmentNumber(sessionId: string): number {
  const db = getDatabase();
  const result = db
    .query<{ max_num: number | null }, [string]>(
      "SELECT MAX(segment_number) as max_num FROM segments WHERE session_id = ?"
    )
    .get(sessionId);
  return result?.max_num ?? -1;
}
