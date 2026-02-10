/**
 * Session Service
 *
 * Manages session lifecycle including timeout detection and processing triggers.
 */
import { createLogger } from "../utils/logger";
import { config } from "../config";
import {
  getTimedOutSessions,
  updateSessionStatus,
  getSession,
  getSessionsByStatus,
} from "../db/sessions";
import { processSession } from "../pipeline/sessionProcessor";

const logger = createLogger("SessionService");

// =============================================================================
// STATE
// =============================================================================

let checkInterval: Timer | null = null;
let isProcessing = false;
const processingQueue: string[] = [];

// =============================================================================
// SESSION COMPLETION
// =============================================================================

/**
 * Mark a session as complete and queue it for processing
 */
export function markSessionComplete(sessionId: string): boolean {
  const session = getSession(sessionId);

  if (!session) {
    logger.warn(`Session not found: ${sessionId}`);
    return false;
  }

  if (session.status !== "receiving") {
    logger.warn(
      `Session ${sessionId} is not in 'receiving' status (current: ${session.status})`
    );
    return false;
  }

  logger.info(`Marking session ${sessionId} as complete`);
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
    logger.info(`Queued session ${sessionId} for processing`);

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
  logger.info(`Starting processing for session: ${sessionId}`);

  try {
    const result = await processSession(sessionId);

    if (result.success) {
      logger.info(
        `Successfully processed session: ${sessionId} ` +
          `(${result.successfulChannels}/${result.channelResults.length} channels)`
      );
    } else {
      logger.error(
        `Failed to process session: ${sessionId} - ${result.error}`
      );
    }
  } catch (error) {
    logger.error(`Error processing session ${sessionId}: ${error}`);
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
  const timedOutSessions = getTimedOutSessions(config.session.timeoutMinutes);

  for (const session of timedOutSessions) {
    logger.info(
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
    logger.info(`Found pending complete session: ${session.id}`);
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
  logger.info(
    `Starting session manager (timeout: ${config.session.timeoutMinutes} minutes)`
  );

  // Check for any pending complete sessions on startup
  checkForPendingCompleteSessions();

  // Start periodic timeout check
  checkInterval = setInterval(() => {
    checkForTimedOutSessions().catch((err) => {
      logger.error(`Error checking for timed out sessions: ${err}`);
    });
  }, config.session.checkIntervalMs);

  logger.info(
    `Session manager started (check interval: ${config.session.checkIntervalMs}ms)`
  );
}

/**
 * Stop the session manager
 */
export function stopSessionManager(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  logger.info("Session manager stopped");
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
    timeoutMinutes: config.session.timeoutMinutes,
  };
}

/**
 * Manually trigger processing for a session
 */
export async function triggerProcessing(sessionId: string): Promise<boolean> {
  const session = getSession(sessionId);

  if (!session) {
    logger.warn(`Session not found: ${sessionId}`);
    return false;
  }

  if (session.status === "processing") {
    logger.warn(`Session ${sessionId} is already processing`);
    return false;
  }

  if (session.status === "processed") {
    logger.warn(`Session ${sessionId} is already processed`);
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

/**
 * Get list of sessions currently in the processing queue
 */
export function getProcessingQueue(): string[] {
  return [...processingQueue];
}

/**
 * Check if a session is in the processing queue
 */
export function isSessionQueued(sessionId: string): boolean {
  return processingQueue.includes(sessionId);
}

/**
 * Remove a session from the processing queue (if not already processing)
 */
export function removeFromQueue(sessionId: string): boolean {
  const index = processingQueue.indexOf(sessionId);
  if (index > -1) {
    processingQueue.splice(index, 1);
    logger.info(`Removed session ${sessionId} from processing queue`);
    return true;
  }
  return false;
}
