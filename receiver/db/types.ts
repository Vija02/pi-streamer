/**
 * Database Types
 *
 * TypeScript interfaces for all database entities.
 */

// =============================================================================
// SESSION
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

// =============================================================================
// SEGMENT
// =============================================================================

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

// =============================================================================
// PROCESSED CHANNEL
// =============================================================================

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
  is_silent: number; // 0 = false, 1 = true (SQLite boolean)
  created_at: string;
}

// =============================================================================
// PIPELINE RUNS (for observability)
// =============================================================================

export type PipelineRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface PipelineRun {
  id: number;
  session_id: string;
  channel_number: number | null; // NULL for session-level runs
  step_name: string;
  status: PipelineRunStatus;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  input_data: string | null; // JSON
  output_data: string | null; // JSON
  error_message: string | null;
  retry_count: number;
  created_at: string;
}

// Typed versions for input/output
export interface PipelineRunInput {
  [key: string]: unknown;
}

export interface PipelineRunOutput {
  [key: string]: unknown;
}

// =============================================================================
// RECORDINGS (metadata and tags)
// =============================================================================

export type RecordingSource = "stream" | "upload";

export interface Recording {
  id: number;
  session_id: string;
  title: string | null;
  description: string | null;
  recorded_at: string | null;
  location: string | null;
  tags: string | null; // JSON array
  metadata: string | null; // JSON object
  source: RecordingSource;
  created_at: string;
  updated_at: string;
}

// Typed version for tags
export type RecordingTags = string[];

// Typed version for metadata
export interface RecordingMetadata {
  [key: string]: unknown;
}

// =============================================================================
// ANNOTATIONS (time markers on recordings)
// =============================================================================

export interface Annotation {
  id: number;
  session_id: string;
  time_seconds: number;
  label: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// CHANNEL SETTINGS (volume, mute state per session)
// =============================================================================

export interface ChannelSetting {
  id: number;
  session_id: string;
  channel_number: number;
  volume: number;
  is_muted: number; // 0 = false, 1 = true (SQLite boolean)
  created_at: string;
  updated_at: string;
}

// =============================================================================
// QUERY RESULT HELPERS
// =============================================================================

export interface SessionStats {
  segmentCount: number;
  channelGroups: string[];
  processedChannelCount: number;
  totalSegmentSize: number;
  totalProcessedSize: number;
  totalDurationSeconds: number | null;
  activeChannelCount: number;
}

export interface PipelineStats {
  totalRuns: number;
  pendingRuns: number;
  runningRuns: number;
  completedRuns: number;
  failedRuns: number;
  skippedRuns: number;
  averageDurationMs: number | null;
}
