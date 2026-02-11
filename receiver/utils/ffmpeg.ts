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
  integratedLoudness: number; // in LUFS
  truePeak: number; // in dBTP
  loudnessRange: number; // in LU
  isQuiet: boolean; // true if audio is mostly quiet/silent
}

/**
 * Analyze audio file to get volume and loudness statistics
 * Uses both volumedetect and loudnorm for comprehensive analysis
 */
export async function analyzeAudio(
  filePath: string,
  quietThresholdDb: number = -40
): Promise<AudioStats> {
  try {
    // Run volumedetect and loudnorm analysis in parallel
    const [volumeResult, loudnormResult] = await Promise.all([
      $`ffmpeg -i ${filePath} -af volumedetect -f null /dev/null`.quiet(),
      $`ffmpeg -i ${filePath} -af loudnorm=print_format=json -f null /dev/null`.quiet(),
    ]);

    const volumeStderr = volumeResult.stderr.toString();
    const loudnormStderr = loudnormResult.stderr.toString();

    // Parse max_volume and mean_volume from volumedetect output
    const maxMatch = volumeStderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
    const meanMatch = volumeStderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);

    const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : 0;
    const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -100;

    // Parse LUFS data from loudnorm output (JSON block)
    let integratedLoudness = -24; // default
    let truePeak = -1;
    let loudnessRange = 7;

    const jsonMatch = loudnormStderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const loudnormData = JSON.parse(jsonMatch[0]);
        integratedLoudness = parseFloat(loudnormData.input_i) || -24;
        truePeak = parseFloat(loudnormData.input_tp) || -1;
        loudnessRange = parseFloat(loudnormData.input_lra) || 7;
      } catch {
        logger.warn("Failed to parse loudnorm JSON output");
      }
    }

    const isQuiet = maxVolume < quietThresholdDb;

    return { maxVolume, meanVolume, integratedLoudness, truePeak, loudnessRange, isQuiet };
  } catch (err) {
    logger.error(`Failed to analyze audio: ${err}`);
    return { 
      maxVolume: 0, 
      meanVolume: -20, 
      integratedLoudness: -24,
      truePeak: -1,
      loudnessRange: 7,
      isQuiet: false 
    };
  }
}

/**
 * Apply LUFS-based loudness normalization using FFmpeg's loudnorm filter
 * This is a two-pass process for accurate loudness normalization
 */
export async function applyLoudnessNormalization(
  inputPath: string,
  outputPath: string,
  targetLufs: number = -16,
  targetTruePeak: number = -1.5,
  targetLra: number = 11, // loudness range
  measuredI?: number, // pre-measured integrated loudness
  measuredTp?: number, // pre-measured true peak
  measuredLra?: number // pre-measured loudness range
): Promise<{ inputLufs: number; outputLufs: number }> {
  let inputI = measuredI;
  let inputTp = measuredTp;
  let inputLra = measuredLra;
  let inputThresh = -24;
  let inputOffset = 0;

  // First pass: measure if not provided
  if (inputI === undefined || inputTp === undefined || inputLra === undefined) {
    logger.debug("Running loudnorm first pass analysis");
    const firstPass = await $`ffmpeg -i ${inputPath} -af loudnorm=print_format=json -f null /dev/null`.quiet();
    
    const stderr = firstPass.stderr.toString();
    const jsonMatch = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
    
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[0]);
        inputI = parseFloat(data.input_i);
        inputTp = parseFloat(data.input_tp);
        inputLra = parseFloat(data.input_lra);
        inputThresh = parseFloat(data.input_thresh);
        inputOffset = parseFloat(data.target_offset);
      } catch {
        throw new Error("Failed to parse loudnorm first pass output");
      }
    } else {
      throw new Error("No loudnorm JSON output found in first pass");
    }
  }

  // Second pass: apply normalization with measured values
  const loudnormFilter = [
    `loudnorm=I=${targetLufs}`,
    `TP=${targetTruePeak}`,
    `LRA=${targetLra}`,
    `measured_I=${inputI}`,
    `measured_TP=${inputTp}`,
    `measured_LRA=${inputLra}`,
    `measured_thresh=${inputThresh}`,
    `offset=${inputOffset}`,
    `linear=true`,
    `print_format=json`,
  ].join(":");

  logger.debug(`Applying loudnorm: ${inputI?.toFixed(1)} LUFS -> ${targetLufs} LUFS`);

  const result = await $`ffmpeg -y -i ${inputPath} -af ${loudnormFilter} -c:a flac ${outputPath}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`Failed to apply loudness normalization: exit code ${result.exitCode}, stderr: ${stderr}`);
  }

  return {
    inputLufs: inputI!,
    outputLufs: targetLufs,
  };
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
