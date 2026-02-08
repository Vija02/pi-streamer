/**
 * Audio Processor Module
 *
 * Processes completed sessions:
 * 1. Extract individual channels from FLAC channel groups
 * 2. Concatenate segments in order
 * 3. Encode to MP3
 * 4. Upload to S3
 */
import { $ } from "bun";
import { join, dirname, resolve } from "path";
import { mkdir, writeFile, unlink, stat } from "fs/promises";
import { S3Client } from "bun";
import {
  getSession,
  getSessionSegments,
  updateSessionStatus,
  insertProcessedChannel,
  updateProcessedChannelS3,
  type Session,
  type Segment,
} from "./db";

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
  mp3Bitrate: process.env.MP3_BITRATE || "320k",
  mp3Quality: Number(process.env.MP3_VBR_QUALITY) || 2, // VBR quality 0-9 (0=best, 9=worst), default 2 (~190kbps for normal audio)
  useVbr: process.env.MP3_USE_VBR !== "false", // Use VBR by default for better compression
  silenceThreshold: Number(process.env.SILENCE_THRESHOLD_DB) || -50, // dB threshold for silence detection
  silenceMinDuration: Number(process.env.SILENCE_MIN_DURATION) || 0.5, // Minimum silence duration in seconds
  quietChannelThreshold: Number(process.env.QUIET_CHANNEL_THRESHOLD_DB) || -40, // If max volume is below this, use lower quality
  quietChannelQuality: Number(process.env.QUIET_CHANNEL_VBR_QUALITY) || 7, // VBR quality for quiet channels (lower quality = smaller file)
  keepFlacAfterProcess: process.env.KEEP_FLAC_AFTER_PROCESS !== "false",
  s3: {
    enabled: process.env.S3_ENABLED !== "false",
    bucket: process.env.S3_BUCKET || "your-audio-bucket",
    region: process.env.AWS_REGION || "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    endpoint: process.env.S3_ENDPOINT,
    prefix: process.env.S3_PREFIX || "processed/",
  },
  localStorage: {
    dir: process.env.LOCAL_STORAGE_DIR || "./received",
  },
};

// S3 client for processed files
const s3Client = config.s3.enabled
  ? new S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      accessKeyId: config.s3.accessKeyId || undefined,
      secretAccessKey: config.s3.secretAccessKey || undefined,
      bucket: config.s3.bucket,
    })
  : null;

function log(message: string, ...args: unknown[]) {
  console.log(`[Processor] [${new Date().toISOString()}] ${message}`, ...args);
}

// =============================================================================
// AUDIO ANALYSIS
// =============================================================================

interface AudioStats {
  maxVolume: number; // in dB (0 = full scale, negative = quieter)
  meanVolume: number; // in dB
  isQuiet: boolean; // true if audio is mostly quiet/silent
}

/**
 * Analyze audio file to get volume statistics
 * Returns max and mean volume in dB, and whether the audio is quiet
 */
async function analyzeAudio(filePath: string): Promise<AudioStats> {
  try {
    // Use ffmpeg's volumedetect filter
    const result = await $`ffmpeg -i ${filePath} -af volumedetect -f null /dev/null`.quiet();
    
    const stderr = result.stderr.toString();
    
    // Parse max_volume and mean_volume from output
    // Example: [Parsed_volumedetect_0 @ 0x...] max_volume: -12.3 dB
    const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
    const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    
    const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : 0;
    const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -100;
    
    // Consider audio quiet if max volume is below threshold
    const isQuiet = maxVolume < config.quietChannelThreshold;
    
    return { maxVolume, meanVolume, isQuiet };
  } catch (err) {
    log(`Failed to analyze audio: ${err}`);
    // Default to non-quiet if analysis fails
    return { maxVolume: 0, meanVolume: -20, isQuiet: false };
  }
}

// =============================================================================
// CHANNEL GROUP MAPPING
// =============================================================================

/**
 * Map from channel group name to the channels it contains
 * e.g., "ch01-06" -> [1, 2, 3, 4, 5, 6]
 */
function parseChannelGroup(channelGroup: string): number[] {
  const match = channelGroup.match(/ch(\d+)-(\d+)/);
  if (!match) return [];

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);

  const channels: number[] = [];
  for (let i = start; i <= end; i++) {
    channels.push(i);
  }
  return channels;
}

/**
 * Get the index of a channel within its channel group (0-indexed)
 */
function getChannelIndexInGroup(channelNumber: number, channelGroup: string): number {
  const channels = parseChannelGroup(channelGroup);
  return channels.indexOf(channelNumber);
}

/**
 * Find which channel group contains a specific channel
 */
function findChannelGroup(channelNumber: number, availableGroups: string[]): string | null {
  for (const group of availableGroups) {
    const channels = parseChannelGroup(group);
    if (channels.includes(channelNumber)) {
      return group;
    }
  }
  return null;
}

// =============================================================================
// AUDIO PROCESSING
// =============================================================================

/**
 * Extract a single channel from a multi-channel FLAC file
 */
async function extractChannelFromFlac(
  flacPath: string,
  channelIndex: number,
  outputPath: string
): Promise<void> {
  // Use ffmpeg to extract a single channel
  // pan=mono|c0=c{channelIndex}
  const filter = `pan=mono|c0=c${channelIndex}`;

  log(`Extracting channel ${channelIndex} from ${flacPath} to ${outputPath}`);

  const result = await $`ffmpeg -y -i ${flacPath} -af ${filter} -c:a flac ${outputPath}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    log(`ffmpeg stderr: ${stderr}`);
    throw new Error(`Failed to extract channel ${channelIndex} from ${flacPath}: exit code ${result.exitCode}, stderr: ${stderr}`);
  }
}

/**
 * Create a concat file for ffmpeg
 * Uses absolute paths to avoid path resolution issues
 */
async function createConcatFile(filePaths: string[], concatFilePath: string): Promise<void> {
  // Use absolute paths to avoid issues with ffmpeg's path resolution
  const content = filePaths.map((p) => `file '${resolve(p)}'`).join("\n");
  await writeFile(concatFilePath, content);
}

/**
 * Concatenate audio files and encode to MP3
 * Uses VBR encoding by default with quality adjustment for quiet channels
 */
async function concatenateAndEncodeToMp3(
  inputFiles: string[],
  outputPath: string,
  tempDir: string,
  audioStats?: AudioStats
): Promise<{ fileSize: number; durationSeconds: number }> {
  const concatFile = join(tempDir, "concat.txt");
  await createConcatFile(inputFiles, concatFile);

  // Determine encoding quality based on audio content
  let encodingArgs: string[];
  
  if (config.useVbr) {
    // Use VBR encoding - much more efficient for varying audio content
    // Quality 0 = ~245 kbps, 2 = ~190 kbps, 4 = ~165 kbps, 6 = ~130 kbps, 9 = ~65 kbps
    const vbrQuality = audioStats?.isQuiet 
      ? config.quietChannelQuality  // Use lower quality for quiet channels
      : config.mp3Quality;
    
    if (audioStats?.isQuiet) {
      log(`  Quiet channel detected (max: ${audioStats.maxVolume.toFixed(1)}dB), using VBR quality ${vbrQuality}`);
    }
    
    encodingArgs = ["-q:a", String(vbrQuality)];
  } else {
    // Use CBR encoding (original behavior)
    encodingArgs = ["-b:a", config.mp3Bitrate];
  }

  log(`Encoding MP3: ${inputFiles.length} files -> ${outputPath} (${config.useVbr ? `VBR q${encodingArgs[1]}` : `CBR ${config.mp3Bitrate}`})`);

  // Concatenate and encode to MP3 in one step
  const result = await $`ffmpeg -y -f concat -safe 0 -i ${concatFile} -c:a libmp3lame ${encodingArgs} ${outputPath}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    log(`MP3 encode failed: ${stderr}`);
    throw new Error(`Failed to encode MP3: exit code ${result.exitCode}, stderr: ${stderr}`);
  }

  // Clean up concat file
  await unlink(concatFile).catch(() => {});

  // Get file info
  const stats = await stat(outputPath);

  // Get duration using ffprobe
  let durationSeconds = 0;
  try {
    const probeResult = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${outputPath}`.quiet();
    if (probeResult.exitCode === 0) {
      durationSeconds = parseFloat(probeResult.stdout.toString().trim()) || 0;
    }
  } catch {
    // Duration is optional
  }

  return {
    fileSize: stats.size,
    durationSeconds,
  };
}

/**
 * Upload MP3 to S3 and return the URL
 */
async function uploadMp3ToS3(
  localPath: string,
  sessionId: string,
  channelNumber: number
): Promise<{ s3Key: string; s3Url: string } | null> {
  if (!s3Client || !config.s3.enabled) return null;

  const s3Key = `${config.s3.prefix}${sessionId}/channel_${String(channelNumber).padStart(2, "0")}.mp3`;

  try {
    const data = await Bun.file(localPath).arrayBuffer();

    const s3File = s3Client.file(s3Key, {
      type: "audio/mpeg",
    });

    await s3File.write(new Uint8Array(data));

    // Construct URL
    let s3Url: string;
    if (config.s3.endpoint) {
      // Custom endpoint (R2, MinIO, etc.)
      s3Url = `${config.s3.endpoint}/${config.s3.bucket}/${s3Key}`;
    } else {
      // Standard AWS S3
      s3Url = `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${s3Key}`;
    }

    log(`Uploaded to S3: ${s3Key}`);

    return { s3Key, s3Url };
  } catch (err) {
    log(`Failed to upload to S3: ${err}`);
    return null;
  }
}

// =============================================================================
// MAIN PROCESSING LOGIC
// =============================================================================

/**
 * Process a single channel for a session
 */
async function processChannel(
  session: Session,
  channelNumber: number,
  segments: Segment[],
  outputDir: string,
  tempDir: string
): Promise<void> {
  log(`Processing channel ${channelNumber} for session ${session.id}`);

  // Group segments by segment number
  const segmentsByNumber = new Map<number, Segment[]>();
  for (const segment of segments) {
    const existing = segmentsByNumber.get(segment.segment_number) || [];
    existing.push(segment);
    segmentsByNumber.set(segment.segment_number, existing);
  }

  // Sort segment numbers
  const segmentNumbers = Array.from(segmentsByNumber.keys()).sort((a, b) => a - b);

  // Extract channel from each segment
  const extractedFiles: string[] = [];

  for (const segNum of segmentNumbers) {
    const segsForNumber = segmentsByNumber.get(segNum)!;

    // Find which segment file contains this channel
    let foundSegment: Segment | null = null;
    let channelIndex = -1;

    for (const seg of segsForNumber) {
      const idx = getChannelIndexInGroup(channelNumber, seg.channel_group);
      if (idx >= 0) {
        foundSegment = seg;
        channelIndex = idx;
        break;
      }
    }

    if (!foundSegment || channelIndex < 0) {
      log(`Warning: Channel ${channelNumber} not found in segment ${segNum}`);
      continue;
    }

    // Extract channel to temp file
    const extractedPath = join(tempDir, `seg${segNum}_ch${channelNumber}.flac`);

    await extractChannelFromFlac(foundSegment.local_path, channelIndex, extractedPath);
    extractedFiles.push(extractedPath);
  }

  if (extractedFiles.length === 0) {
    log(`Warning: No segments found for channel ${channelNumber}`);
    return;
  }

  // Analyze the first extracted file to determine if channel is quiet
  // This helps us choose appropriate encoding quality
  let audioStats: AudioStats | undefined;
  if (extractedFiles.length > 0) {
    audioStats = await analyzeAudio(extractedFiles[0]);
    log(`  Channel ${channelNumber} audio stats: max=${audioStats.maxVolume.toFixed(1)}dB, mean=${audioStats.meanVolume.toFixed(1)}dB, quiet=${audioStats.isQuiet}`);
  }

  // Concatenate and encode to MP3
  const mp3Path = join(outputDir, `channel_${String(channelNumber).padStart(2, "0")}.mp3`);

  const { fileSize, durationSeconds } = await concatenateAndEncodeToMp3(
    extractedFiles,
    mp3Path,
    tempDir,
    audioStats
  );

  log(`Created MP3: ${mp3Path} (${(fileSize / 1024 / 1024).toFixed(2)} MB, ${durationSeconds.toFixed(1)}s)`);

  // Clean up extracted temp files
  for (const file of extractedFiles) {
    await unlink(file).catch(() => {});
  }

  // Upload to S3
  const s3Result = await uploadMp3ToS3(mp3Path, session.id, channelNumber);

  // Record in database
  const channel = insertProcessedChannel(
    session.id,
    channelNumber,
    mp3Path,
    fileSize,
    s3Result?.s3Key,
    s3Result?.s3Url,
    durationSeconds
  );

  if (s3Result) {
    updateProcessedChannelS3(channel.id, s3Result.s3Key, s3Result.s3Url);
  }
}

/**
 * Process a complete session - create MP3 for each channel
 */
export async function processSession(sessionId: string): Promise<boolean> {
  log(`Starting processing for session: ${sessionId}`);

  const session = getSession(sessionId);
  if (!session) {
    log(`Session not found: ${sessionId}`);
    return false;
  }

  if (session.status === "processing" || session.status === "processed") {
    log(`Session ${sessionId} is already ${session.status}`);
    return false;
  }

  try {
    // Update status to processing
    updateSessionStatus(sessionId, "processing");

    // Get all segments for this session
    const segments = getSessionSegments(sessionId);
    if (segments.length === 0) {
      log(`No segments found for session ${sessionId}`);
      updateSessionStatus(sessionId, "failed");
      return false;
    }

    log(`Found ${segments.length} segments for session ${sessionId}`);

    // Create output and temp directories
    const sessionDir = join(config.localStorage.dir, sessionId);
    const outputDir = join(sessionDir, "mp3");
    const tempDir = join(sessionDir, ".temp");

    await mkdir(outputDir, { recursive: true });
    await mkdir(tempDir, { recursive: true });

    // Determine total channels from session
    const totalChannels = session.channels;

    // Process each channel
    const errors: string[] = [];

    for (let channelNum = 1; channelNum <= totalChannels; channelNum++) {
      try {
        await processChannel(session, channelNum, segments, outputDir, tempDir);
      } catch (err) {
        const errorMsg = `Failed to process channel ${channelNum}: ${err}`;
        log(errorMsg);
        errors.push(errorMsg);
        // Continue processing other channels
      }
    }

    // Clean up temp directory
    await $`rm -rf ${tempDir}`.quiet().catch(() => {});

    // Update session status
    if (errors.length === 0) {
      updateSessionStatus(sessionId, "processed");
      log(`Successfully processed session ${sessionId}`);
      return true;
    } else if (errors.length < totalChannels) {
      // Partial success - some channels processed
      updateSessionStatus(sessionId, "processed");
      log(`Partially processed session ${sessionId} (${errors.length} errors)`);
      return true;
    } else {
      // All channels failed
      updateSessionStatus(sessionId, "failed");
      log(`Failed to process session ${sessionId}`);
      return false;
    }
  } catch (err) {
    log(`Error processing session ${sessionId}: ${err}`);
    updateSessionStatus(sessionId, "failed");
    return false;
  }
}

/**
 * Check if ffmpeg is available
 */
export async function checkFfmpeg(): Promise<boolean> {
  try {
    const result = await $`which ffmpeg`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
