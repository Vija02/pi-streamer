/**
 * FFmpeg Utilities
 *
 * Provides wrappers around FFmpeg and audiowaveform commands.
 */
import { $ } from "bun";
import { createLogger } from "./logger";

const logger = createLogger("FFmpeg");

/**
 * Check if ffmpeg is available on the system
 */
export async function checkFfmpeg(): Promise<boolean> {
  try {
    const result = await $`which ffmpeg`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if audiowaveform is available on the system
 */
export async function checkAudiowaveform(): Promise<boolean> {
  try {
    const result = await $`which audiowaveform`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Audio statistics from volume detection
 */
export interface AudioStats {
  maxVolume: number; // in dB (0 = full scale, negative = quieter)
  meanVolume: number; // in dB
  isQuiet: boolean; // true if audio is mostly quiet/silent
}

/**
 * Analyze audio file to get volume statistics
 */
export async function analyzeAudio(
  filePath: string,
  quietThresholdDb: number = -40
): Promise<AudioStats> {
  try {
    const result = await $`ffmpeg -i ${filePath} -af volumedetect -f null /dev/null`.quiet();

    const stderr = result.stderr.toString();

    // Parse max_volume and mean_volume from output
    const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
    const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);

    const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : 0;
    const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -100;
    const isQuiet = maxVolume < quietThresholdDb;

    return { maxVolume, meanVolume, isQuiet };
  } catch (err) {
    logger.error(`Failed to analyze audio: ${err}`);
    return { maxVolume: 0, meanVolume: -20, isQuiet: false };
  }
}

/**
 * Extract a single channel from a multi-channel FLAC file
 */
export async function extractChannel(
  inputPath: string,
  channelIndex: number,
  outputPath: string
): Promise<void> {
  const filter = `pan=mono|c0=c${channelIndex}`;

  logger.debug(`Extracting channel ${channelIndex} from ${inputPath}`);

  const result = await $`ffmpeg -y -i ${inputPath} -af ${filter} -c:a flac ${outputPath}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(
      `Failed to extract channel ${channelIndex}: exit code ${result.exitCode}, stderr: ${stderr}`
    );
  }
}

/**
 * Get duration of an audio file using ffprobe
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const result =
      await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${filePath}`.quiet();

    if (result.exitCode === 0) {
      return parseFloat(result.stdout.toString().trim()) || 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Concatenate audio files using a concat file
 */
export async function concatenateAudio(
  concatFilePath: string,
  outputPath: string,
  codec: "flac" | "copy" = "flac"
): Promise<void> {
  const result =
    await $`ffmpeg -y -f concat -safe 0 -i ${concatFilePath} -c:a ${codec} ${outputPath}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`Failed to concatenate audio: exit code ${result.exitCode}, stderr: ${stderr}`);
  }
}

/**
 * Options for MP3 encoding
 */
export interface Mp3EncodeOptions {
  useVbr: boolean;
  vbrQuality: number;
  bitrate: string;
  audioFilters?: string[];
}

/**
 * Encode audio to MP3
 */
export async function encodeToMp3(
  inputPath: string,
  outputPath: string,
  options: Mp3EncodeOptions
): Promise<void> {
  const encodingArgs = options.useVbr
    ? ["-q:a", String(options.vbrQuality)]
    : ["-b:a", options.bitrate];

  const filterArgs =
    options.audioFilters && options.audioFilters.length > 0
      ? ["-af", options.audioFilters.join(",")]
      : [];

  const result =
    await $`ffmpeg -y -i ${inputPath} ${filterArgs} -c:a libmp3lame ${encodingArgs} ${outputPath}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`Failed to encode MP3: exit code ${result.exitCode}, stderr: ${stderr}`);
  }
}

/**
 * Encode from concat file directly to MP3
 */
export async function concatAndEncodeToMp3(
  concatFilePath: string,
  outputPath: string,
  options: Mp3EncodeOptions
): Promise<void> {
  const encodingArgs = options.useVbr
    ? ["-q:a", String(options.vbrQuality)]
    : ["-b:a", options.bitrate];

  const filterArgs =
    options.audioFilters && options.audioFilters.length > 0
      ? ["-af", options.audioFilters.join(",")]
      : [];

  const result =
    await $`ffmpeg -y -f concat -safe 0 -i ${concatFilePath} ${filterArgs} -c:a libmp3lame ${encodingArgs} ${outputPath}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(
      `Failed to concat and encode MP3: exit code ${result.exitCode}, stderr: ${stderr}`
    );
  }
}

/**
 * Generate HLS segments from an audio file
 */
export async function generateHls(
  inputPath: string,
  m3u8Path: string,
  segmentPattern: string,
  segmentDuration: number,
  audioBitrate: string
): Promise<void> {
  const result =
    await $`ffmpeg -y -i ${inputPath} -c:a aac -b:a ${audioBitrate} -hls_time ${segmentDuration} -hls_list_size 0 -hls_segment_filename ${segmentPattern} ${m3u8Path}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`Failed to generate HLS: exit code ${result.exitCode}, stderr: ${stderr}`);
  }
}

/**
 * Generate waveform peaks using audiowaveform
 */
export async function generatePeaks(
  inputPath: string,
  outputPath: string,
  pixelsPerSecond: number,
  bits: number
): Promise<void> {
  const result =
    await $`audiowaveform -i ${inputPath} -o ${outputPath} --pixels-per-second ${pixelsPerSecond} --bits ${bits}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`Failed to generate peaks: exit code ${result.exitCode}, stderr: ${stderr}`);
  }
}

/**
 * Apply volume adjustment to audio
 */
export async function applyVolumeGain(
  inputPath: string,
  outputPath: string,
  gainDb: number
): Promise<void> {
  const filter = `volume=${gainDb.toFixed(2)}dB`;

  const result =
    await $`ffmpeg -y -i ${inputPath} -af ${filter} -c:a flac ${outputPath}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`Failed to apply volume gain: exit code ${result.exitCode}, stderr: ${stderr}`);
  }
}
