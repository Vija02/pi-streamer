/**
 * Pipeline Types
 *
 * Interfaces and types for the step-based audio processing pipeline.
 */
import type { Segment, ProcessedChannel } from "../db/types";
import type { AudioStats } from "../utils/ffmpeg";

// =============================================================================
// STEP CONTEXT
// =============================================================================

/**
 * Context passed to each pipeline step
 */
export interface StepContext {
  /** Session ID being processed */
  sessionId: string;

  /** Channel number being processed (1-18) */
  channelNumber: number;

  /** Working directory for temporary files */
  workDir: string;

  /** Output directory for final files */
  outputDir: string;

  /** Pipeline run ID for logging (if tracked) */
  pipelineRunId?: number;
}

/**
 * Accumulated data passed between steps
 */
export interface PipelineData {
  /** Segments for this channel (populated by prefetch step) */
  segments?: Segment[];

  /** Paths to extracted channel FLAC files (one per segment) */
  extractedPaths?: string[];

  /** Path to concatenated FLAC file */
  concatenatedPath?: string;

  /** Path to uploaded MP3 file (for upload pipeline) */
  uploadedMp3Path?: string;

  /** Audio analysis results */
  audioStats?: AudioStats;

  /** Path to normalized FLAC file (if normalization applied) */
  normalizedPath?: string;

  /** Path to encoded MP3 file */
  mp3Path?: string;

  /** MP3 file size in bytes */
  mp3FileSize?: number;

  /** Audio duration in seconds */
  durationSeconds?: number;

  /** Path to peaks JSON file */
  peaksPath?: string;

  /** Path to HLS m3u8 playlist */
  hlsPlaylistPath?: string;

  /** Paths to HLS segment files */
  hlsSegmentPaths?: string[];

  /** S3 URL for uploaded MP3 */
  mp3S3Url?: string;

  /** S3 key for uploaded MP3 */
  mp3S3Key?: string;

  /** S3 URL for uploaded peaks */
  peaksS3Url?: string;

  /** S3 URL for uploaded HLS playlist */
  hlsS3Url?: string;

  /** Whether this is a quiet channel */
  isQuiet?: boolean;

  /** Whether this is a silent channel */
  isSilent?: boolean;

  /** Any additional data steps want to pass along */
  [key: string]: unknown;
}

// =============================================================================
// STEP RESULT
// =============================================================================

/**
 * Result returned by each pipeline step
 */
export interface StepResult {
  /** Whether the step succeeded */
  success: boolean;

  /** Data to merge into pipeline data for next steps */
  data?: Partial<PipelineData>;

  /** Error message if failed */
  error?: string;

  /** Whether the step was skipped (e.g., output already exists) */
  skipped?: boolean;

  /** Reason for skipping */
  skipReason?: string;

  /** Metrics about the step execution */
  metrics?: StepMetrics;
}

/**
 * Metrics captured during step execution
 */
export interface StepMetrics {
  /** Execution time in milliseconds */
  durationMs: number;

  /** Bytes processed (if applicable) */
  bytesProcessed?: number;

  /** Files created (if applicable) */
  filesCreated?: number;

  /** Any additional metrics */
  [key: string]: unknown;
}

// =============================================================================
// PIPELINE STEP
// =============================================================================

/**
 * Interface that all pipeline steps must implement
 */
export interface PipelineStep {
  /** Unique name for this step */
  name: string;

  /** Human-readable description */
  description: string;

  /**
   * Check if the step should run
   * Return false to skip (e.g., if output already exists)
   */
  shouldRun(ctx: StepContext, data: PipelineData): Promise<boolean>;

  /**
   * Execute the step
   */
  execute(ctx: StepContext, data: PipelineData): Promise<StepResult>;

  /**
   * Clean up any resources on failure (optional)
   */
  cleanup?(ctx: StepContext, data: PipelineData): Promise<void>;
}

// =============================================================================
// PIPELINE OPTIONS
// =============================================================================

/**
 * Options for running the pipeline
 */
export interface PipelineOptions {
  /** Maximum retry attempts per step (default: 3) */
  maxRetries?: number;

  /** Initial delay between retries in ms (default: 1000) */
  retryDelayMs?: number;

  /** Multiplier for exponential backoff (default: 2) */
  retryBackoffMultiplier?: number;

  /** Whether to track runs in the database (default: true) */
  trackInDatabase?: boolean;

  /** Callback when a step starts */
  onStepStart?: (stepName: string, ctx: StepContext) => void;

  /** Callback when a step completes */
  onStepComplete?: (stepName: string, result: StepResult) => void;

  /** Callback when a step fails */
  onStepError?: (stepName: string, error: Error, retryCount: number) => void;

  /** Callback when a step is skipped */
  onStepSkip?: (stepName: string, reason: string) => void;
}

// =============================================================================
// PIPELINE RESULT
// =============================================================================

/**
 * Final result of running the full pipeline
 */
export interface PipelineResult {
  /** Whether all steps succeeded */
  success: boolean;

  /** Final accumulated pipeline data */
  data: PipelineData;

  /** Results from each step, keyed by step name */
  stepResults: Map<string, StepResult>;

  /** Total execution time in milliseconds */
  totalDurationMs: number;

  /** Steps that failed */
  failedSteps: string[];

  /** Steps that were skipped */
  skippedSteps: string[];

  /** Overall error message if pipeline failed */
  error?: string;
}

// =============================================================================
// CHANNEL PROCESSOR RESULT
// =============================================================================

/**
 * Result of processing a single channel
 */
export interface ChannelProcessorResult {
  success: boolean;
  channelNumber: number;
  mp3Path?: string;
  mp3S3Url?: string;
  peaksPath?: string;
  peaksS3Url?: string;
  hlsS3Url?: string;
  durationSeconds?: number;
  fileSize?: number;
  isQuiet?: boolean;
  isSilent?: boolean;
  error?: string;
  pipelineResult?: PipelineResult;
}

// =============================================================================
// SESSION PROCESSOR RESULT
// =============================================================================

/**
 * Result of processing a full session (all channels)
 */
export interface SessionProcessorResult {
  success: boolean;
  sessionId: string;
  channelResults: ChannelProcessorResult[];
  successfulChannels: number;
  failedChannels: number;
  totalDurationMs: number;
  error?: string;
}

// =============================================================================
// AUDIO STATS (re-export for convenience)
// =============================================================================

export type { AudioStats } from "../utils/ffmpeg";
