/**
 * Admin Routes
 *
 * Pipeline inspection and management endpoints.
 */
import { Hono } from "hono";
import { createLogger } from "../utils/logger";
import {
  getSessionPipelineRuns,
  getChannelPipelineRuns,
  getPipelineRun,
  getFailedPipelineRuns,
  getGlobalPipelineStats,
  getSessionPipelineStats,
  parseInputData,
  parseOutputData,
  incrementRetryCount,
} from "../db/pipelineRuns";
import {
  getProcessedChannel,
  updateProcessedChannelFlags,
} from "../db/channels";
import { getAllSessions, getSessionsByStatus } from "../db/sessions";
import { getRecordingsCountBySource, getAllTags } from "../db/recordings";
import { runSingleStep } from "../pipeline/runner";
import { getStepByName } from "../pipeline/steps";
import { getTempDir, getMp3Dir } from "../utils/paths";
import { config } from "../config";

const logger = createLogger("AdminRoutes");

const app = new Hono();

/**
 * GET /pipeline-runs - List all pipeline runs with optional filters
 */
app.get("/pipeline-runs", async (c) => {
  const status = c.req.query("status");
  const sessionId = c.req.query("sessionId");
  const limit = parseInt(c.req.query("limit") || "100", 10);

  let runs;

  if (sessionId) {
    runs = getSessionPipelineRuns(sessionId);
  } else if (status === "failed") {
    runs = getFailedPipelineRuns(config.pipeline.maxRetries);
  } else {
    // Get runs from recent sessions
    const sessions = getAllSessions().slice(0, 10);
    runs = sessions.flatMap((s) => getSessionPipelineRuns(s.id));
  }

  // Apply limit
  runs = runs.slice(0, limit);

  // Parse JSON fields
  const runsWithParsedData = runs.map((run) => ({
    ...run,
    inputData: parseInputData(run),
    outputData: parseOutputData(run),
  }));

  return c.json({
    runs: runsWithParsedData,
    total: runs.length,
  });
});

/**
 * GET /pipeline-runs/:sessionId - Get pipeline runs for a session
 */
app.get("/pipeline-runs/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");

  const runs = getSessionPipelineRuns(sessionId);
  const stats = getSessionPipelineStats(sessionId);

  const runsWithParsedData = runs.map((run) => ({
    ...run,
    inputData: parseInputData(run),
    outputData: parseOutputData(run),
  }));

  return c.json({
    sessionId,
    stats,
    runs: runsWithParsedData,
  });
});

/**
 * GET /pipeline-runs/:sessionId/:channel - Get pipeline runs for a specific channel
 */
app.get("/pipeline-runs/:sessionId/:channel", async (c) => {
  const sessionId = c.req.param("sessionId");
  const channelNumber = parseInt(c.req.param("channel"), 10);

  const runs = getChannelPipelineRuns(sessionId, channelNumber);

  const runsWithParsedData = runs.map((run) => ({
    ...run,
    inputData: parseInputData(run),
    outputData: parseOutputData(run),
  }));

  return c.json({
    sessionId,
    channelNumber,
    runs: runsWithParsedData,
  });
});

/**
 * POST /pipeline-runs/:runId/retry - Retry a failed pipeline step
 */
app.post("/pipeline-runs/:runId/retry", async (c) => {
  const runId = parseInt(c.req.param("runId"), 10);

  const run = getPipelineRun(runId);
  if (!run) {
    return c.json({ error: "Pipeline run not found" }, 404);
  }

  if (run.status !== "failed") {
    return c.json({ error: "Can only retry failed runs" }, 400);
  }

  // Get the step
  const step = getStepByName(run.step_name);
  if (!step) {
    return c.json({ error: `Step '${run.step_name}' not found` }, 404);
  }

  logger.info(`Retrying pipeline run ${runId} (step: ${run.step_name})`);

  // Create context
  const ctx = {
    sessionId: run.session_id,
    channelNumber: run.channel_number || 1,
    workDir: getTempDir(run.session_id),
    outputDir: getMp3Dir(run.session_id),
    pipelineRunId: runId,
  };

  // Parse input data
  const inputData = parseInputData(run) || {};

  try {
    // Increment retry count
    incrementRetryCount(runId);

    // Run the step
    const result = await runSingleStep(step, ctx, inputData, {
      trackInDatabase: false, // Don't create a new run, we're retrying the existing one
    });

    // If the step was analyze-audio and it succeeded, update the channel flags
    if (
      result.success &&
      run.step_name === "analyze-audio" &&
      result.data &&
      (result.data.isQuiet !== undefined || result.data.isSilent !== undefined)
    ) {
      const channel = getProcessedChannel(run.session_id, run.channel_number || 1);
      if (channel) {
        updateProcessedChannelFlags(
          channel.id,
          result.data.isQuiet ?? false,
          result.data.isSilent ?? false
        );
        logger.info(
          `Updated channel ${run.channel_number} flags: quiet=${result.data.isQuiet}, silent=${result.data.isSilent}`
        );
      }
    }

    return c.json({
      success: result.success,
      runId,
      stepName: run.step_name,
      result: {
        success: result.success,
        skipped: result.skipped,
        error: result.error,
        data: result.data,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Retry failed for run ${runId}: ${message}`);
    return c.json({ error: "Retry failed", message }, 500);
  }
});

/**
 * GET /stats - Global processing statistics
 */
app.get("/stats", async (c) => {
  const pipelineStats = getGlobalPipelineStats();
  const recordingCounts = getRecordingsCountBySource();
  const allTags = getAllTags();

  // Session status counts
  const allSessions = getAllSessions();
  const sessionsByStatus = {
    receiving: getSessionsByStatus("receiving").length,
    complete: getSessionsByStatus("complete").length,
    processing: getSessionsByStatus("processing").length,
    processed: getSessionsByStatus("processed").length,
    failed: getSessionsByStatus("failed").length,
  };

  return c.json({
    sessions: {
      total: allSessions.length,
      byStatus: sessionsByStatus,
    },
    recordings: {
      total: recordingCounts.stream + recordingCounts.upload,
      bySource: recordingCounts,
      tags: allTags,
      tagCount: allTags.length,
    },
    pipeline: pipelineStats,
    config: {
      maxRetries: config.pipeline.maxRetries,
      timeoutMinutes: config.session.timeoutMinutes,
    },
  });
});

export default app;
