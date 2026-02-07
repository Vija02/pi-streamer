/**
 * Session Manager Module
 *
 * Manages session lifecycle:
 * - Tracks active sessions
 * - Handles timeout detection
 * - Triggers processing when sessions complete
 */
import {
  getTimedOutSessions,
  updateSessionStatus,
  getSession,
  getSessionsByStatus,
  type Session,
} from "./db";
import { processSession } from "./processor";

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
  // Timeout in minutes before a session is considered complete (no new segments)
  sessionTimeoutMinutes: Number(process.env.SESSION_TIMEOUT_MINUTES) || 10,

  // How often to check for timed out sessions (in ms)
  checkIntervalMs: Number(process.env.SESSION_CHECK_INTERVAL_MS) || 60000, // 1 minute
};

// =============================================================================
// STATE
// =============================================================================

let checkInterval: Timer | null = null;
let isProcessing = false;
const processingQueue: string[] = [];

function log(message: string, ...args: unknown[]) {
  console.log(`[SessionManager] [${new Date().toISOString()}] ${message}`, ...args);
}

// =============================================================================
// SESSION COMPLETION
// =============================================================================

/**
 * Mark a session as complete and queue it for processing
 */
export function markSessionComplete(sessionId: string): boolean {
  const session = getSession(sessionId);

  if (!session) {
    log(`Session not found: ${sessionId}`);
    return false;
  }

  if (session.status !== "receiving") {
    log(`Session ${sessionId} is not in 'receiving' status (current: ${session.status})`);
    return false;
  }

  log(`Marking session ${sessionId} as complete`);
  updateSessionStatus(sessionId, "complete");

  // Queue for processing
  queueSessionForProcessing(sessionId);

  return true;
}

/**
 * Queue a session for processing
 */
function queueSessionForProcessing(sessionId: string): void {
  if (!processingQueue.includes(sessionId)) {
    processingQueue.push(sessionId);
    log(`Queued session ${sessionId} for processing`);

    // Start processing if not already running
    processNextSession();
  }
}

/**
 * Process the next session in the queue
 */
async function processNextSession(): Promise<void> {
  if (isProcessing) return;
  if (processingQueue.length === 0) return;

  isProcessing = true;

  const sessionId = processingQueue.shift()!;
  log(`Starting processing for session: ${sessionId}`);

  try {
    const success = await processSession(sessionId);
    if (success) {
      log(`Successfully processed session: ${sessionId}`);
    } else {
      log(`Failed to process session: ${sessionId}`);
    }
  } catch (err) {
    log(`Error processing session ${sessionId}: ${err}`);
    updateSessionStatus(sessionId, "failed");
  }

  isProcessing = false;

  // Process next session if any
  if (processingQueue.length > 0) {
    processNextSession();
  }
}

// =============================================================================
// TIMEOUT DETECTION
// =============================================================================

/**
 * Check for timed out sessions and queue them for processing
 */
async function checkForTimedOutSessions(): Promise<void> {
  const timedOutSessions = getTimedOutSessions(config.sessionTimeoutMinutes);

  for (const session of timedOutSessions) {
    log(
      `Session ${session.id} timed out (last update: ${session.updated_at})`
    );

    // Mark as complete
    updateSessionStatus(session.id, "complete");

    // Queue for processing
    queueSessionForProcessing(session.id);
  }
}

/**
 * Check for sessions that are marked as complete but not yet processing
 * This handles cases where the server restarted after marking complete
 */
async function checkForPendingCompleteSessions(): Promise<void> {
  const completeSessions = getSessionsByStatus("complete");

  for (const session of completeSessions) {
    log(`Found pending complete session: ${session.id}`);
    queueSessionForProcessing(session.id);
  }
}

// =============================================================================
// LIFECYCLE
// =============================================================================

/**
 * Start the session manager
 */
export function startSessionManager(): void {
  log(`Starting session manager (timeout: ${config.sessionTimeoutMinutes} minutes)`);

  // Check for any pending complete sessions on startup
  checkForPendingCompleteSessions();

  // Start periodic timeout check
  checkInterval = setInterval(() => {
    checkForTimedOutSessions().catch((err) => {
      log(`Error checking for timed out sessions: ${err}`);
    });
  }, config.checkIntervalMs);

  log(`Session manager started (check interval: ${config.checkIntervalMs}ms)`);
}

/**
 * Stop the session manager
 */
export function stopSessionManager(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  log("Session manager stopped");
}

/**
 * Get session manager status
 */
export function getSessionManagerStatus(): {
  isRunning: boolean;
  isProcessing: boolean;
  queueLength: number;
  timeoutMinutes: number;
} {
  return {
    isRunning: checkInterval !== null,
    isProcessing,
    queueLength: processingQueue.length,
    timeoutMinutes: config.sessionTimeoutMinutes,
  };
}

/**
 * Manually trigger processing for a session
 */
export async function triggerProcessing(sessionId: string): Promise<boolean> {
  const session = getSession(sessionId);

  if (!session) {
    log(`Session not found: ${sessionId}`);
    return false;
  }

  if (session.status === "processing") {
    log(`Session ${sessionId} is already processing`);
    return false;
  }

  if (session.status === "processed") {
    log(`Session ${sessionId} is already processed`);
    return false;
  }

  // If still receiving, mark as complete first
  if (session.status === "receiving") {
    updateSessionStatus(sessionId, "complete");
  }

  // Queue for processing
  queueSessionForProcessing(sessionId);

  return true;
}
