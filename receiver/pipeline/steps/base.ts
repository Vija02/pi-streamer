/**
 * Base Pipeline Step
 *
 * Abstract base class for pipeline steps with common functionality.
 */
import { createLogger, type Logger } from "../../utils/logger";
import type { PipelineStep, StepContext, PipelineData, StepResult } from "../types";

/**
 * Abstract base class for pipeline steps
 *
 * Provides:
 * - Logging with step name prefix
 * - Default shouldRun() implementation (always runs)
 * - Default cleanup() implementation (no-op)
 * - Helper methods for creating results
 */
export abstract class BaseStep implements PipelineStep {
  abstract name: string;
  abstract description: string;

  protected logger: Logger;

  constructor() {
    // Logger will be initialized in init() after name is set
    this.logger = createLogger("Pipeline");
  }

  /**
   * Initialize the step (called by subclass constructor after setting name)
   */
  protected init(): void {
    this.logger = createLogger(`Pipeline:${this.name}`);
  }

  /**
   * Default implementation - always run the step
   * Override in subclass to implement skip logic
   */
  async shouldRun(_ctx: StepContext, _data: PipelineData): Promise<boolean> {
    return true;
  }

  /**
   * Execute the step - must be implemented by subclass
   */
  abstract execute(ctx: StepContext, data: PipelineData): Promise<StepResult>;

  /**
   * Default cleanup implementation - no-op
   * Override in subclass if cleanup is needed
   */
  async cleanup(_ctx: StepContext, _data: PipelineData): Promise<void> {
    // No-op by default
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  /**
   * Create a successful result
   */
  protected success(data?: Partial<PipelineData>, metrics?: StepResult["metrics"]): StepResult {
    return {
      success: true,
      data,
      metrics,
    };
  }

  /**
   * Create a failed result
   */
  protected failure(error: string, metrics?: StepResult["metrics"]): StepResult {
    return {
      success: false,
      error,
      metrics,
    };
  }

  /**
   * Create a skipped result
   */
  protected skip(reason: string): StepResult {
    return {
      success: true,
      skipped: true,
      skipReason: reason,
    };
  }

  /**
   * Log and create a failure result
   */
  protected logFailure(error: unknown, context?: string): StepResult {
    const message = error instanceof Error ? error.message : String(error);
    const fullMessage = context ? `${context}: ${message}` : message;
    this.logger.error(fullMessage);
    return this.failure(fullMessage);
  }

  /**
   * Measure execution time
   */
  protected async timed<T>(
    fn: () => Promise<T>
  ): Promise<{ result: T; durationMs: number }> {
    const start = Date.now();
    const result = await fn();
    const durationMs = Date.now() - start;
    return { result, durationMs };
  }
}
