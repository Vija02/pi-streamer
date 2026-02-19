/**
 * Database Connection
 *
 * Core database connection management.
 * This is separated to avoid circular dependencies.
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { config } from "../config";
import { createLogger } from "../utils/logger";

const logger = createLogger("Database");

let db: Database | null = null;

/**
 * Get the database file path
 */
export function getDbPath(): string {
  return config.localStorage.dbPath;
}

/**
 * Initialize the database and create all tables
 */
export function initDatabase(): Database {
  if (db) return db;

  const dbPath = getDbPath();

  // Ensure directory exists
  const dir = join(dbPath, "..");
  mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.run("PRAGMA journal_mode = WAL");

  // Create tables
  createTables(db);

  // Run migrations
  runMigrations(db);

  // Create indexes
  createIndexes(db);

  logger.info(`Initialized database at ${dbPath}`);

  return db;
}

/**
 * Get the database instance (initializes if needed)
 */
export function getDatabase(): Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info("Database connection closed");
  }
}

// =============================================================================
// SCHEMA
// =============================================================================

function createTables(db: Database): void {
  // Sessions table
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

  // Segments table
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

  // Processed channels table
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
      is_silent INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      UNIQUE(session_id, channel_number)
    )
  `);

  // Pipeline runs table (for observability)
  db.run(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      channel_number INTEGER,
      step_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      input_data TEXT,
      output_data TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Recordings table (metadata and tags)
  db.run(`
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      title TEXT,
      description TEXT,
      recorded_at TEXT,
      location TEXT,
      tags TEXT,
      metadata TEXT,
      source TEXT DEFAULT 'stream',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Annotations table (time markers on recordings)
  db.run(`
    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      time_seconds REAL NOT NULL,
      label TEXT NOT NULL,
      color TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Channel settings table (volume, mute state per session)
  db.run(`
    CREATE TABLE IF NOT EXISTS channel_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      channel_number INTEGER NOT NULL,
      volume REAL NOT NULL DEFAULT 1.0,
      is_muted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      UNIQUE(session_id, channel_number)
    )
  `);
}

// =============================================================================
// MIGRATIONS
// =============================================================================

function runMigrations(db: Database): void {
  // Migration: Add new columns if they don't exist (for existing databases)

  // processed_channels migrations
  tryAddColumn(db, "processed_channels", "hls_url", "TEXT");
  tryAddColumn(db, "processed_channels", "peaks_url", "TEXT");
  tryAddColumn(db, "processed_channels", "is_quiet", "INTEGER DEFAULT 0");
  tryAddColumn(db, "processed_channels", "is_silent", "INTEGER DEFAULT 0");
}

function tryAddColumn(
  db: Database,
  table: string,
  column: string,
  definition: string
): void {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info(`Added ${column} column to ${table}`);
  } catch {
    // Column already exists - this is expected
  }
}

// =============================================================================
// INDEXES
// =============================================================================

function createIndexes(db: Database): void {
  // Session indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);

  // Segment indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id)`);

  // Processed channel indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_processed_session ON processed_channels(session_id)`);

  // Pipeline run indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_session ON pipeline_runs(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_session_channel ON pipeline_runs(session_id, channel_number)`
  );

  // Recording indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id)`);

  // Annotation indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_annotations_session ON annotations(session_id)`);

  // Channel settings indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_channel_settings_session ON channel_settings(session_id)`);
}
