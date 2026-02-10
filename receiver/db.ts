/**
 * SQLite Database Module
 *
 * Uses Bun's built-in SQLite for tracking sessions, segments, and processed channels.
 */
import { Database } from "bun:sqlite";
import { join } from "path";

// =============================================================================
// TYPES
// =============================================================================

export type SessionStatus =
  | "receiving"
  | "complete"
  | "processing"
  | "processed"
  | "failed";

export interface Session {
  id: string;
  status: SessionStatus;
  sample_rate: number;
  channels: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  processed_at: string | null;
}

export interface Segment {
  id: number;
  session_id: string;
  segment_number: number;
  channel_group: string;
  local_path: string;
  s3_key: string | null;
  file_size: number;
  received_at: string;
}

export interface ProcessedChannel {
  id: number;
  session_id: string;
  channel_number: number;
  local_path: string;
  s3_key: string | null;
  s3_url: string | null;
  hls_url: string | null;
  peaks_url: string | null;
  file_size: number;
  duration_seconds: number | null;
  is_quiet: number; // 0 = false, 1 = true (SQLite boolean)
  created_at: string;
}

// =============================================================================
// DATABASE INITIALIZATION
// =============================================================================

let db: Database | null = null;

export function getDbPath(): string {
  return process.env.DB_PATH || "./data/receiver.db";
}

export function initDatabase(): Database {
  if (db) return db;

  const dbPath = getDbPath();

  // Ensure directory exists
  const dir = join(dbPath, "..");
  require("fs").mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.run("PRAGMA journal_mode = WAL");

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'receiving',
      sample_rate INTEGER NOT NULL DEFAULT 48000,
      channels INTEGER NOT NULL DEFAULT 18,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      processed_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      segment_number INTEGER NOT NULL,
      channel_group TEXT NOT NULL,
      local_path TEXT NOT NULL,
      s3_key TEXT,
      file_size INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      UNIQUE(session_id, segment_number, channel_group)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS processed_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      channel_number INTEGER NOT NULL,
      local_path TEXT NOT NULL,
      s3_key TEXT,
      s3_url TEXT,
      hls_url TEXT,
      peaks_url TEXT,
      file_size INTEGER NOT NULL,
      duration_seconds REAL,
      is_quiet INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      UNIQUE(session_id, channel_number)
    )
  `);

  // Migration: Add new columns if they don't exist (for existing databases)
  try {
    db.run(`ALTER TABLE processed_channels ADD COLUMN hls_url TEXT`);
    console.log("[DB] Added hls_url column");
  } catch {
    // Column already exists
  }
  try {
    db.run(`ALTER TABLE processed_channels ADD COLUMN peaks_url TEXT`);
    console.log("[DB] Added peaks_url column");
  } catch {
    // Column already exists
  }
  try {
    db.run(`ALTER TABLE processed_channels ADD COLUMN is_quiet INTEGER DEFAULT 0`);
    console.log("[DB] Added is_quiet column");
  } catch {
    // Column already exists
  }

  // Create indexes for common queries
  db.run(`CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_processed_session ON processed_channels(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);

  console.log(`[DB] Initialized database at ${dbPath}`);

  return db;
}

export function getDatabase(): Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

// =============================================================================
// SESSION OPERATIONS
// =============================================================================

export function upsertSession(
  sessionId: string,
  sampleRate: number = 48000,
  channels: number = 18
): Session {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Try to insert, update if exists
  const existing = db
    .query<Session, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId);

  if (existing) {
    db.run(
      "UPDATE sessions SET updated_at = ? WHERE id = ?",
      [now, sessionId]
    );
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

export function getSession(sessionId: string): Session | null {
  const db = getDatabase();
  return db
    .query<Session, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId);
}

export function getAllSessions(): Session[] {
  const db = getDatabase();
  return db
    .query<Session, []>("SELECT * FROM sessions ORDER BY created_at DESC")
    .all();
}

export function getSessionsByStatus(status: SessionStatus): Session[] {
  const db = getDatabase();
  return db
    .query<Session, [string]>("SELECT * FROM sessions WHERE status = ? ORDER BY updated_at ASC")
    .all(status);
}

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
    db.run(
      "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
      [status, now, sessionId]
    );
  }
}

export function touchSession(sessionId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [now, sessionId]);
}

// =============================================================================
// SEGMENT OPERATIONS
// =============================================================================

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

export function updateSegmentS3Key(segmentId: number, s3Key: string): void {
  const db = getDatabase();
  db.run("UPDATE segments SET s3_key = ? WHERE id = ?", [s3Key, segmentId]);
}

export function getSessionSegmentCount(sessionId: string): number {
  const db = getDatabase();
  const result = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM segments WHERE session_id = ?"
    )
    .get(sessionId);
  return result?.count ?? 0;
}

// =============================================================================
// PROCESSED CHANNEL OPERATIONS
// =============================================================================

export function insertProcessedChannel(
  sessionId: string,
  channelNumber: number,
  localPath: string,
  fileSize: number,
  s3Key?: string,
  s3Url?: string,
  durationSeconds?: number,
  hlsUrl?: string,
  peaksUrl?: string,
  isQuiet?: boolean
): ProcessedChannel {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.run(
    `INSERT OR REPLACE INTO processed_channels 
     (session_id, channel_number, local_path, s3_key, s3_url, hls_url, peaks_url, file_size, duration_seconds, is_quiet, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      channelNumber,
      localPath,
      s3Key ?? null,
      s3Url ?? null,
      hlsUrl ?? null,
      peaksUrl ?? null,
      fileSize,
      durationSeconds ?? null,
      isQuiet ? 1 : 0,
      now,
    ]
  );

  const channel = db
    .query<ProcessedChannel, [string, number]>(
      "SELECT * FROM processed_channels WHERE session_id = ? AND channel_number = ?"
    )
    .get(sessionId, channelNumber);

  return channel!;
}

export function getProcessedChannels(sessionId: string): ProcessedChannel[] {
  const db = getDatabase();
  return db
    .query<ProcessedChannel, [string]>(
      `SELECT * FROM processed_channels 
       WHERE session_id = ? 
       ORDER BY channel_number ASC`
    )
    .all(sessionId);
}

export function updateProcessedChannelS3(
  channelId: number,
  s3Key: string,
  s3Url: string
): void {
  const db = getDatabase();
  db.run(
    "UPDATE processed_channels SET s3_key = ?, s3_url = ? WHERE id = ?",
    [s3Key, s3Url, channelId]
  );
}

export function updateProcessedChannelHlsAndPeaks(
  channelId: number,
  hlsUrl: string | null,
  peaksUrl: string | null
): void {
  const db = getDatabase();
  db.run(
    "UPDATE processed_channels SET hls_url = ?, peaks_url = ? WHERE id = ?",
    [hlsUrl, peaksUrl, channelId]
  );
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

export function getSessionStats(sessionId: string): {
  segmentCount: number;
  channelGroups: string[];
  processedChannelCount: number;
  totalSegmentSize: number;
  totalProcessedSize: number;
} {
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

  return {
    segmentCount: segmentStats?.count ?? 0,
    channelGroups,
    processedChannelCount: processedStats?.count ?? 0,
    totalSegmentSize: segmentStats?.total_size ?? 0,
    totalProcessedSize: processedStats?.total_size ?? 0,
  };
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
