/**
 * Session Database Operations
 */
import { getDatabase } from "./connection";
import type { Session, SessionStatus, SessionStats } from "./types";

/**
 * Create or update a session
 */
export function upsertSession(
  sessionId: string,
  sampleRate: number = 48000,
  channels: number = 18
): Session {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Try to get existing session
  const existing = db
    .query<Session, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId);

  if (existing) {
    db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [now, sessionId]);
    return { ...existing, updated_at: now };
  }

  db.run(
    `INSERT INTO sessions (id, status, sample_rate, channels, created_at, updated_at)
     VALUES (?, 'receiving', ?, ?, ?, ?)`,
    [sessionId, sampleRate, channels, now, now]
  );

  return {
    id: sessionId,
    status: "receiving",
    sample_rate: sampleRate,
    channels: channels,
    created_at: now,
    updated_at: now,
    completed_at: null,
    processed_at: null,
  };
}

/**
 * Get a session by ID
 */
export function getSession(sessionId: string): Session | null {
  const db = getDatabase();
  return db
    .query<Session, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId);
}

/**
 * Get all sessions, ordered by creation date (newest first)
 */
export function getAllSessions(): Session[] {
  const db = getDatabase();
  return db
    .query<Session, []>("SELECT * FROM sessions ORDER BY created_at DESC")
    .all();
}

/**
 * Get sessions by status
 */
export function getSessionsByStatus(status: SessionStatus): Session[] {
  const db = getDatabase();
  return db
    .query<Session, [string]>(
      "SELECT * FROM sessions WHERE status = ? ORDER BY updated_at ASC"
    )
    .all(status);
}

/**
 * Get sessions that have timed out (no activity for specified minutes)
 */
export function getTimedOutSessions(timeoutMinutes: number): Session[] {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  return db
    .query<Session, [string]>(
      `SELECT * FROM sessions 
       WHERE status = 'receiving' AND updated_at < ?
       ORDER BY updated_at ASC`
    )
    .all(cutoff);
}

/**
 * Update session status
 */
export function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  let extraFields = "";
  if (status === "complete") {
    extraFields = ", completed_at = ?";
  } else if (status === "processed") {
    extraFields = ", processed_at = ?";
  }

  if (extraFields) {
    db.run(
      `UPDATE sessions SET status = ?, updated_at = ?${extraFields} WHERE id = ?`,
      [status, now, now, sessionId]
    );
  } else {
    db.run("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?", [
      status,
      now,
      sessionId,
    ]);
  }
}

/**
 * Touch session to update last activity time
 */
export function touchSession(sessionId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [now, sessionId]);
}

/**
 * Get session statistics
 */
export function getSessionStats(sessionId: string): SessionStats {
  const db = getDatabase();

  const segmentStats = db
    .query<{ count: number; total_size: number }, [string]>(
      `SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_size 
       FROM segments WHERE session_id = ?`
    )
    .get(sessionId);

  const channelGroups = db
    .query<{ channel_group: string }, [string]>(
      `SELECT DISTINCT channel_group FROM segments WHERE session_id = ?`
    )
    .all(sessionId)
    .map((r) => r.channel_group);

  const processedStats = db
    .query<{ count: number; total_size: number }, [string]>(
      `SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_size 
       FROM processed_channels WHERE session_id = ?`
    )
    .get(sessionId);

  // Get duration from first channel that has it
  const durationResult = db
    .query<{ duration: number | null }, [string]>(
      `SELECT duration_seconds as duration FROM processed_channels 
       WHERE session_id = ? AND duration_seconds IS NOT NULL
       LIMIT 1`
    )
    .get(sessionId);

  // Get count of non-quiet channels (active channels)
  const activeChannelResult = db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM processed_channels 
       WHERE session_id = ? AND is_quiet = 0`
    )
    .get(sessionId);

  return {
    segmentCount: segmentStats?.count ?? 0,
    channelGroups,
    processedChannelCount: processedStats?.count ?? 0,
    totalSegmentSize: segmentStats?.total_size ?? 0,
    totalProcessedSize: processedStats?.total_size ?? 0,
    totalDurationSeconds: durationResult?.duration ?? null,
    activeChannelCount: activeChannelResult?.count ?? 0,
  };
}

/**
 * Delete a session and all related data
 */
export function deleteSession(sessionId: string): boolean {
  const db = getDatabase();

  // Check if session exists
  const session = getSession(sessionId);
  if (!session) {
    return false;
  }

  // Delete related data first (foreign key constraints)
  db.run("DELETE FROM pipeline_runs WHERE session_id = ?", [sessionId]);
  db.run("DELETE FROM recordings WHERE session_id = ?", [sessionId]);
  db.run("DELETE FROM processed_channels WHERE session_id = ?", [sessionId]);
  db.run("DELETE FROM segments WHERE session_id = ?", [sessionId]);
  db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);

  return true;
}
