/**
 * Pipeline Steps Registry
 *
 * Exports all pipeline steps and provides the default channel processing pipeline.
 */
import type { PipelineStep } from "../types";

// Export individual steps
export { prefetchFlacStep, PrefetchFlacStep } from "./prefetchFlac";
export { extractChannelStep, ExtractChannelStep } from "./extractChannel";
export { concatenateStep, ConcatenateStep } from "./concatenate";
export { analyzeAudioStep, AnalyzeAudioStep } from "./analyzeAudio";
export { normalizeAudioStep, NormalizeAudioStep } from "./normalizeAudio";
export { encodeMp3Step, EncodeMp3Step } from "./encodeMp3";
export { generatePeaksStep, GeneratePeaksStep } from "./generatePeaks";
export { generateHlsStep, GenerateHlsStep } from "./generateHls";
export { uploadMp3Step, UploadMp3Step } from "./uploadMp3";
export { uploadPeaksStep, UploadPeaksStep } from "./uploadPeaks";
export { uploadHlsStep, UploadHlsStep } from "./uploadHls";

// Import step instances for pipeline
import { prefetchFlacStep } from "./prefetchFlac";
import { extractChannelStep } from "./extractChannel";
import { concatenateStep } from "./concatenate";
import { analyzeAudioStep } from "./analyzeAudio";
import { normalizeAudioStep } from "./normalizeAudio";
import { encodeMp3Step } from "./encodeMp3";
import { generatePeaksStep } from "./generatePeaks";
import { generateHlsStep } from "./generateHls";
import { uploadMp3Step } from "./uploadMp3";
import { uploadPeaksStep } from "./uploadPeaks";
import { uploadHlsStep } from "./uploadHls";

/**
 * Default pipeline for processing a single channel
 *
 * Steps in order:
 * 1. prefetch-flac - Download FLAC segments from S3 if needed
 * 2. extract-channel - Extract single channel from multi-channel FLACs
 * 3. concatenate - Combine all segments into one file
 * 4. analyze-audio - Detect volume levels, quiet/silent status
 * 5. normalize-audio - Apply peak normalization (if enabled & not quiet)
 * 6. encode-mp3 - Encode to MP3 with appropriate quality
 * 7. generate-peaks - Create waveform JSON
 * 8. generate-hls - Create HLS segments
 * 9. upload-mp3 - Upload MP3 to S3
 * 10. upload-peaks - Upload peaks JSON to S3
 * 11. upload-hls - Upload HLS files to S3
 */
export const defaultChannelPipeline: PipelineStep[] = [
  prefetchFlacStep,
  extractChannelStep,
  concatenateStep,
  analyzeAudioStep,
  normalizeAudioStep,
  encodeMp3Step,
  generatePeaksStep,
  generateHlsStep,
  uploadMp3Step,
  uploadPeaksStep,
  uploadHlsStep,
];

/**
 * Pipeline for regenerating only peaks (from existing MP3)
 */
export const peaksOnlyPipeline: PipelineStep[] = [
  generatePeaksStep,
  uploadPeaksStep,
];

/**
 * Pipeline for regenerating only HLS (from existing MP3)
 */
export const hlsOnlyPipeline: PipelineStep[] = [
  generateHlsStep,
  uploadHlsStep,
];

/**
 * Pipeline for regenerating peaks and HLS (from existing MP3)
 */
export const peaksAndHlsPipeline: PipelineStep[] = [
  generatePeaksStep,
  generateHlsStep,
  uploadPeaksStep,
  uploadHlsStep,
];

/**
 * Get a step by name
 */
export function getStepByName(name: string): PipelineStep | undefined {
  return defaultChannelPipeline.find((step) => step.name === name);
}

/**
 * Get all step names
 */
export function getAllStepNames(): string[] {
  return defaultChannelPipeline.map((step) => step.name);
}
