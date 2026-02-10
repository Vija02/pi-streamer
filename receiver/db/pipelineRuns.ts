/**
 * Pipeline Runs Database Operations
 *
 * Tracks execution of each pipeline step for observability and retry capability.
 */
import { getDatabase } from "./connection";
import type {
  PipelineRun,
  PipelineRunStatus,
  PipelineRunInput,
  PipelineRunOutput,
  PipelineStats,
} from "./types";

/**
 * Create a new pipeline run record
 */
export function createPipelineRun(
  sessionId: string,
  stepName: string,
  channelNumber?: number,
  inputData?: PipelineRunInput
): PipelineRun {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO pipeline_runs 
     (session_id, channel_number, step_name, status, input_data, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    [
      sessionId,
      channelNumber ?? null,
      stepName,
      inputData ? JSON.stringify(inputData) : null,
      now,
    ]
  );

  // Get the inserted record
  const result = db
    .query<{ id: number }, []>("SELECT last_insert_rowid() as id")
    .get();

  return getPipelineRun(result!.id)!;
}

/**
 * Get a pipeline run by ID
 */
export function getPipelineRun(runId: number): PipelineRun | null {
  const db = getDatabase();
  return db
    .query<PipelineRun, [number]>("SELECT * FROM pipeline_runs WHERE id = ?")
    .get(runId);
}

/**
 * Mark a pipeline run as started
 */
export function startPipelineRun(runId: number): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    "UPDATE pipeline_runs SET status = 'running', started_at = ? WHERE id = ?",
    [now, runId]
  );
}

/**
 * Mark a pipeline run as completed
 */
export function completePipelineRun(
  runId: number,
  outputData?: PipelineRunOutput
): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Calculate duration
  const run = getPipelineRun(runId);
  const durationMs = run?.started_at
    ? new Date(now).getTime() - new Date(run.started_at).getTime()
    : null;

  db.run(
    `UPDATE pipeline_runs 
     SET status = 'completed', completed_at = ?, duration_ms = ?, output_data = ?
     WHERE id = ?`,
    [now, durationMs, outputData ? JSON.stringify(outputData) : null, runId]
  );
}

/**
 * Mark a pipeline run as failed
 */
export function failPipelineRun(runId: number, errorMessage: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Calculate duration
  const run = getPipelineRun(runId);
  const durationMs = run?.started_at
    ? new Date(now).getTime() - new Date(run.started_at).getTime()
    : null;

  db.run(
    `UPDATE pipeline_runs 
     SET status = 'failed', completed_at = ?, duration_ms = ?, error_message = ?
     WHERE id = ?`,
    [now, durationMs, errorMessage, runId]
  );
}

/**
 * Mark a pipeline run as skipped
 */
export function skipPipelineRun(runId: number, reason?: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.run(
    `UPDATE pipeline_runs 
     SET status = 'skipped', completed_at = ?, output_data = ?
     WHERE id = ?`,
    [now, reason ? JSON.stringify({ reason }) : null, runId]
  );
}

/**
 * Increment retry count for a pipeline run
 */
export function incrementRetryCount(runId: number): number {
  const db = getDatabase();
  db.run(
    "UPDATE pipeline_runs SET retry_count = retry_count + 1, status = 'pending' WHERE id = ?",
    [runId]
  );

  const run = getPipelineRun(runId);
  return run?.retry_count ?? 0;
}

/**
 * Get all pipeline runs for a session
 */
export function getSessionPipelineRuns(sessionId: string): PipelineRun[] {
  const db = getDatabase();
  return db
    .query<PipelineRun, [string]>(
      `SELECT * FROM pipeline_runs 
       WHERE session_id = ? 
       ORDER BY created_at ASC`
    )
    .all(sessionId);
}

/**
 * Get pipeline runs for a specific channel
 */
export function getChannelPipelineRuns(
  sessionId: string,
  channelNumber: number
): PipelineRun[] {
  const db = getDatabase();
  return db
    .query<PipelineRun, [string, number]>(
      `SELECT * FROM pipeline_runs 
       WHERE session_id = ? AND channel_number = ?
       ORDER BY created_at ASC`
    )
    .all(sessionId, channelNumber);
}

/**
 * Get pipeline runs by status
 */
export function getPipelineRunsByStatus(status: PipelineRunStatus): PipelineRun[] {
  const db = getDatabase();
  return db
    .query<PipelineRun, [string]>(
      `SELECT * FROM pipeline_runs 
       WHERE status = ? 
       ORDER BY created_at ASC`
    )
    .all(status);
}

/**
 * Get failed pipeline runs that can be retried
 */
export function getFailedPipelineRuns(maxRetries: number = 3): PipelineRun[] {
  const db = getDatabase();
  return db
    .query<PipelineRun, [number]>(
      `SELECT * FROM pipeline_runs 
       WHERE status = 'failed' AND retry_count < ?
       ORDER BY created_at ASC`
    )
    .all(maxRetries);
}

/**
 * Get failed pipeline runs for a session
 */
export function getSessionFailedRuns(sessionId: string): PipelineRun[] {
  const db = getDatabase();
  return db
    .query<PipelineRun, [string]>(
      `SELECT * FROM pipeline_runs 
       WHERE session_id = ? AND status = 'failed'
       ORDER BY created_at ASC`
    )
    .all(sessionId);
}

/**
 * Get pipeline statistics for a session
 */
export function getSessionPipelineStats(sessionId: string): PipelineStats {
  const db = getDatabase();

  const stats = db
    .query<
      {
        total: number;
        pending: number;
        running: number;
        completed: number;
        failed: number;
        skipped: number;
        avg_duration: number | null;
      },
      [string]
    >(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
        AVG(duration_ms) as avg_duration
       FROM pipeline_runs
       WHERE session_id = ?`
    )
    .get(sessionId);

  return {
    totalRuns: stats?.total ?? 0,
    pendingRuns: stats?.pending ?? 0,
    runningRuns: stats?.running ?? 0,
    completedRuns: stats?.completed ?? 0,
    failedRuns: stats?.failed ?? 0,
    skippedRuns: stats?.skipped ?? 0,
    averageDurationMs: stats?.avg_duration ?? null,
  };
}

/**
 * Get global pipeline statistics
 */
export function getGlobalPipelineStats(): PipelineStats {
  const db = getDatabase();

  const stats = db
    .query<
      {
        total: number;
        pending: number;
        running: number;
        completed: number;
        failed: number;
        skipped: number;
        avg_duration: number | null;
      },
      []
    >(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
        AVG(duration_ms) as avg_duration
       FROM pipeline_runs`
    )
    .get();

  return {
    totalRuns: stats?.total ?? 0,
    pendingRuns: stats?.pending ?? 0,
    runningRuns: stats?.running ?? 0,
    completedRuns: stats?.completed ?? 0,
    failedRuns: stats?.failed ?? 0,
    skippedRuns: stats?.skipped ?? 0,
    averageDurationMs: stats?.avg_duration ?? null,
  };
}

/**
 * Delete old pipeline runs (for future cleanup if needed)
 */
export function deleteOldPipelineRuns(olderThanDays: number): number {
  const db = getDatabase();
  const cutoff = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const result = db.run(
    "DELETE FROM pipeline_runs WHERE created_at < ? AND status IN ('completed', 'skipped')",
    [cutoff]
  );

  return result.changes;
}

/**
 * Get the latest run for a specific step and channel
 */
export function getLatestPipelineRun(
  sessionId: string,
  stepName: string,
  channelNumber?: number
): PipelineRun | null {
  const db = getDatabase();

  if (channelNumber !== undefined) {
    return db
      .query<PipelineRun, [string, string, number]>(
        `SELECT * FROM pipeline_runs 
         WHERE session_id = ? AND step_name = ? AND channel_number = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(sessionId, stepName, channelNumber);
  }

  return db
    .query<PipelineRun, [string, string]>(
      `SELECT * FROM pipeline_runs 
       WHERE session_id = ? AND step_name = ? AND channel_number IS NULL
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(sessionId, stepName);
}

/**
 * Parse input data from a pipeline run
 */
export function parseInputData(run: PipelineRun): PipelineRunInput | null {
  if (!run.input_data) return null;
  try {
    return JSON.parse(run.input_data);
  } catch {
    return null;
  }
}

/**
 * Parse output data from a pipeline run
 */
export function parseOutputData(run: PipelineRun): PipelineRunOutput | null {
  if (!run.output_data) return null;
  try {
    return JSON.parse(run.output_data);
  } catch {
    return null;
  }
}
