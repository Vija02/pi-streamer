/**
 * Pipeline Runner
 *
 * Orchestrates execution of pipeline steps with retry logic and observability.
 */
import { createLogger } from "../utils/logger";
import { config } from "../config";
import {
  createPipelineRun,
  startPipelineRun,
  completePipelineRun,
  failPipelineRun,
  skipPipelineRun,
  incrementRetryCount,
} from "../db/pipelineRuns";
import type { PipelineRunInput, PipelineRunOutput } from "../db/types";
import type {
  PipelineStep,
  StepContext,
  StepResult,
  PipelineData,
  PipelineOptions,
  PipelineResult,
} from "./types";

const logger = createLogger("PipelineRunner");

/**
 * Sleep for a given duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single step with retry logic
 */
async function runStepWithRetry(
  step: PipelineStep,
  ctx: StepContext,
  data: PipelineData,
  options: Required<PipelineOptions>,
  dbRunId?: number
): Promise<StepResult> {
  let lastError: Error | null = null;
  let retryCount = 0;

  while (retryCount <= options.maxRetries) {
    try {
      // Check if step should run
      const shouldRun = await step.shouldRun(ctx, data);

      if (!shouldRun) {
        const skipReason = "Step conditions not met (skipped by shouldRun)";
        logger.debug(`Skipping step ${step.name}: ${skipReason}`);

        if (dbRunId) {
          skipPipelineRun(dbRunId, skipReason);
        }

        options.onStepSkip?.(step.name, skipReason);

        return {
          success: true,
          skipped: true,
          skipReason,
        };
      }

      // Mark as running in DB
      if (dbRunId) {
        startPipelineRun(dbRunId);
      }

      // Notify callback
      options.onStepStart?.(step.name, ctx);

      // Execute step
      const result = await step.execute(ctx, data);

      // Handle result
      if (result.success) {
        if (dbRunId) {
          completePipelineRun(dbRunId, result.data as PipelineRunOutput);
        }

        if (result.skipped) {
          options.onStepSkip?.(step.name, result.skipReason || "Skipped");
        } else {
          options.onStepComplete?.(step.name, result);
        }

        return result;
      } else {
        // Step failed, throw to trigger retry
        throw new Error(result.error || "Step failed without error message");
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      retryCount++;
      options.onStepError?.(step.name, lastError, retryCount);

      if (retryCount <= options.maxRetries) {
        // Update retry count in DB
        if (dbRunId) {
          incrementRetryCount(dbRunId);
        }

        // Calculate delay with exponential backoff
        const delay =
          options.retryDelayMs *
          Math.pow(options.retryBackoffMultiplier, retryCount - 1);

        logger.warn(
          `Step ${step.name} failed (attempt ${retryCount}/${options.maxRetries + 1}), ` +
            `retrying in ${delay}ms: ${lastError.message}`
        );

        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  const errorMessage = lastError?.message || "Unknown error";
  logger.error(`Step ${step.name} failed after ${retryCount} attempts: ${errorMessage}`);

  if (dbRunId) {
    failPipelineRun(dbRunId, errorMessage);
  }

  // Run cleanup
  try {
    await step.cleanup?.(ctx, data);
  } catch (cleanupError) {
    logger.warn(`Cleanup for step ${step.name} failed: ${cleanupError}`);
  }

  return {
    success: false,
    error: errorMessage,
  };
}

/**
 * Run a pipeline of steps
 */
export async function runPipeline(
  steps: PipelineStep[],
  ctx: StepContext,
  initialData: PipelineData = {},
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const startTime = Date.now();

  // Merge with default options
  const opts: Required<PipelineOptions> = {
    maxRetries: options.maxRetries ?? config.pipeline.maxRetries,
    retryDelayMs: options.retryDelayMs ?? config.pipeline.retryDelayMs,
    retryBackoffMultiplier:
      options.retryBackoffMultiplier ?? config.pipeline.retryBackoffMultiplier,
    trackInDatabase: options.trackInDatabase ?? true,
    onStepStart: options.onStepStart ?? (() => {}),
    onStepComplete: options.onStepComplete ?? (() => {}),
    onStepError: options.onStepError ?? (() => {}),
    onStepSkip: options.onStepSkip ?? (() => {}),
  };

  logger.info(
    `Starting pipeline with ${steps.length} steps for session ${ctx.sessionId}, channel ${ctx.channelNumber}`
  );

  // Accumulate data through pipeline
  let data: PipelineData = { ...initialData };
  const stepResults = new Map<string, StepResult>();
  const failedSteps: string[] = [];
  const skippedSteps: string[] = [];

  for (const step of steps) {
    // Create DB record for tracking (if enabled)
    let dbRunId: number | undefined;
    if (opts.trackInDatabase) {
      const run = createPipelineRun(
        ctx.sessionId,
        step.name,
        ctx.channelNumber,
        data as PipelineRunInput
      );
      dbRunId = run.id;
    }

    // Run the step
    const result = await runStepWithRetry(step, ctx, data, opts, dbRunId);
    stepResults.set(step.name, result);

    if (result.skipped) {
      skippedSteps.push(step.name);
    } else if (!result.success) {
      failedSteps.push(step.name);

      // Stop pipeline on failure
      logger.error(`Pipeline stopped due to failure in step ${step.name}`);
      break;
    }

    // Merge result data into accumulated data
    if (result.data) {
      data = { ...data, ...result.data };
    }
  }

  const totalDurationMs = Date.now() - startTime;
  const success = failedSteps.length === 0;

  if (success) {
    logger.info(
      `Pipeline completed successfully in ${totalDurationMs}ms ` +
        `(${skippedSteps.length} skipped, ${steps.length - skippedSteps.length} executed)`
    );
  } else {
    logger.error(
      `Pipeline failed after ${totalDurationMs}ms. Failed steps: ${failedSteps.join(", ")}`
    );
  }

  return {
    success,
    data,
    stepResults,
    totalDurationMs,
    failedSteps,
    skippedSteps,
    error: success ? undefined : `Pipeline failed at step: ${failedSteps[0]}`,
  };
}

/**
 * Run a single step (useful for retrying specific steps)
 */
export async function runSingleStep(
  step: PipelineStep,
  ctx: StepContext,
  data: PipelineData = {},
  options: PipelineOptions = {}
): Promise<StepResult> {
  const opts: Required<PipelineOptions> = {
    maxRetries: options.maxRetries ?? config.pipeline.maxRetries,
    retryDelayMs: options.retryDelayMs ?? config.pipeline.retryDelayMs,
    retryBackoffMultiplier:
      options.retryBackoffMultiplier ?? config.pipeline.retryBackoffMultiplier,
    trackInDatabase: options.trackInDatabase ?? true,
    onStepStart: options.onStepStart ?? (() => {}),
    onStepComplete: options.onStepComplete ?? (() => {}),
    onStepError: options.onStepError ?? (() => {}),
    onStepSkip: options.onStepSkip ?? (() => {}),
  };

  let dbRunId: number | undefined;
  if (opts.trackInDatabase) {
    const run = createPipelineRun(
      ctx.sessionId,
      step.name,
      ctx.channelNumber,
      data as PipelineRunInput
    );
    dbRunId = run.id;
  }

  return runStepWithRetry(step, ctx, data, opts, dbRunId);
}
