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
import { join, dirname, resolve, basename } from "path";
import { mkdir, writeFile, unlink, stat, readdir } from "fs/promises";
import { S3Client } from "bun";
import {
  getSession,
  getSessionSegments,
  getProcessedChannels,
  updateSessionStatus,
  insertProcessedChannel,
  updateProcessedChannelS3,
  updateProcessedChannelHlsAndPeaks,
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
  // Peak normalization: target peak level in dB (null to disable)
  normalizePeakDb: process.env.NORMALIZE_PEAK_DB === "" ? null : Number(process.env.NORMALIZE_PEAK_DB ?? -1),
  hls: {
    segmentDuration: Number(process.env.HLS_SEGMENT_DURATION) || 10, // seconds per HLS segment
    audioBitrate: process.env.HLS_AUDIO_BITRATE || "128k", // AAC bitrate for HLS
  },
  peaks: {
    pixelsPerSecond: Number(process.env.PEAKS_PIXELS_PER_SECOND) || 50, // medium resolution (~5KB per minute)
    bits: Number(process.env.PEAKS_BITS) || 8, // 8-bit precision
  },
  s3: {
    enabled: process.env.S3_ENABLED !== "false",
    bucket: process.env.S3_BUCKET || "your-audio-bucket",
    region: process.env.AWS_REGION || "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    endpoint: process.env.S3_ENDPOINT,
    publicUrl: process.env.S3_PUBLIC_URL, // Public URL base for accessing files (e.g., https://files.example.com)
    prefix: process.env.S3_PREFIX || "processed/",
    hlsPrefix: process.env.S3_HLS_PREFIX || "hls/",
    peaksPrefix: process.env.S3_PEAKS_PREFIX || "peaks/",
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
 * Applies peak normalization if configured and channel is not quiet
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

  // Calculate normalization gain (only for non-quiet channels)
  let audioFilters: string[] = [];
  if (audioStats && !audioStats.isQuiet && config.normalizePeakDb !== null) {
    const gain = config.normalizePeakDb - audioStats.maxVolume;
    // Only apply if gain is meaningful (more than 0.5dB adjustment)
    if (Math.abs(gain) > 0.5) {
      audioFilters.push(`volume=${gain.toFixed(2)}dB`);
      log(`  Normalizing: ${gain > 0 ? '+' : ''}${gain.toFixed(1)}dB (peak: ${audioStats.maxVolume.toFixed(1)}dB -> ${config.normalizePeakDb}dB)`);
    }
  }

  const filterArgs = audioFilters.length > 0 ? ["-af", audioFilters.join(",")] : [];

  log(`Encoding MP3: ${inputFiles.length} files -> ${outputPath} (${config.useVbr ? `VBR q${encodingArgs[1]}` : `CBR ${config.mp3Bitrate}`})`);

  // Concatenate and encode to MP3 in one step
  const result = await $`ffmpeg -y -f concat -safe 0 -i ${concatFile} ${filterArgs} -c:a libmp3lame ${encodingArgs} ${outputPath}`.quiet();

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

    // Construct URL - ensure it has a protocol prefix
    const ensureProtocol = (url: string) =>
      url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;

    let s3Url: string;
    if (config.s3.publicUrl) {
      // Use explicit public URL (for R2, custom domains, etc.)
      s3Url = `${ensureProtocol(config.s3.publicUrl)}/${s3Key}`;
    } else if (config.s3.endpoint) {
      // Custom endpoint (R2, MinIO, etc.) - use endpoint as public URL
      s3Url = `${ensureProtocol(config.s3.endpoint)}/${config.s3.bucket}/${s3Key}`;
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
// HLS AND PEAKS GENERATION
// =============================================================================

/**
 * Helper to build public S3 URL
 */
function buildS3Url(s3Key: string): string {
  const ensureProtocol = (url: string) =>
    url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;

  if (config.s3.publicUrl) {
    return `${ensureProtocol(config.s3.publicUrl)}/${s3Key}`;
  } else if (config.s3.endpoint) {
    return `${ensureProtocol(config.s3.endpoint)}/${config.s3.bucket}/${s3Key}`;
  }
  return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${s3Key}`;
}

/**
 * Generate waveform peaks JSON using audiowaveform
 * Normalizes the data to -1 to 1 range for WaveSurfer.js
 */
async function generatePeaks(
  mp3Path: string,
  outputPath: string
): Promise<void> {
  log(`Generating peaks: ${mp3Path} -> ${outputPath}`);

  // Generate peaks JSON using audiowaveform
  const result = await $`audiowaveform -i ${mp3Path} -o ${outputPath} --pixels-per-second ${config.peaks.pixelsPerSecond} --bits ${config.peaks.bits}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`Failed to generate peaks: exit code ${result.exitCode}, stderr: ${stderr}`);
  }

  // Normalize peaks data (convert to -1 to 1 range for WaveSurfer)
  await normalizePeaksFile(outputPath);
}

/**
 * Normalize peaks file to -1 to 1 range
 * audiowaveform outputs values in the range of the bit depth (e.g., -128 to 127 for 8-bit)
 */
async function normalizePeaksFile(filePath: string): Promise<void> {
  const content = await Bun.file(filePath).json();
  const data = content.data as number[];

  if (!data || data.length === 0) {
    log(`Warning: Peaks file has no data: ${filePath}`);
    return;
  }

  // Find max absolute value
  const maxVal = Math.max(...data.map(Math.abs));
  if (maxVal === 0) {
    log(`Warning: Peaks data is all zeros: ${filePath}`);
    return;
  }

  // Normalize to -1 to 1 range, round to 2 decimals
  content.data = data.map((x: number) => Math.round((x / maxVal) * 100) / 100);

  await Bun.write(filePath, JSON.stringify(content));
  log(`Normalized peaks file: ${filePath} (${data.length} samples, max was ${maxVal})`);
}

/**
 * Generate HLS segments from MP3
 */
async function generateHls(
  mp3Path: string,
  outputDir: string,
  channelNumber: number
): Promise<{ m3u8Path: string; segmentFiles: string[] }> {
  const padded = String(channelNumber).padStart(2, "0");
  const m3u8Path = join(outputDir, `channel_${padded}.m3u8`);
  const segmentPattern = join(outputDir, `channel_${padded}_%03d.ts`);

  log(`Generating HLS: ${mp3Path} -> ${m3u8Path}`);

  const result = await $`ffmpeg -y -i ${mp3Path} -c:a aac -b:a ${config.hls.audioBitrate} -hls_time ${config.hls.segmentDuration} -hls_list_size 0 -hls_segment_filename ${segmentPattern} ${m3u8Path}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`Failed to generate HLS: exit code ${result.exitCode}, stderr: ${stderr}`);
  }

  // Get list of generated segment files
  const files = await readdir(outputDir);
  const segmentFiles = files
    .filter((f) => f.startsWith(`channel_${padded}_`) && f.endsWith(".ts"))
    .map((f) => join(outputDir, f));

  log(`Generated HLS: ${m3u8Path} (${segmentFiles.length} segments)`);

  return { m3u8Path, segmentFiles };
}

/**
 * Upload HLS files to S3
 */
async function uploadHlsToS3(
  m3u8Path: string,
  segmentFiles: string[],
  sessionId: string,
  channelNumber: number
): Promise<string | null> {
  if (!s3Client || !config.s3.enabled) return null;

  const padded = String(channelNumber).padStart(2, "0");
  const prefix = `${config.s3.hlsPrefix}${sessionId}/`;

  try {
    // Upload m3u8 playlist
    const m3u8Key = `${prefix}channel_${padded}.m3u8`;
    const m3u8Data = await Bun.file(m3u8Path).arrayBuffer();
    await s3Client
      .file(m3u8Key, { type: "application/vnd.apple.mpegurl" })
      .write(new Uint8Array(m3u8Data));

    log(`Uploaded HLS playlist: ${m3u8Key}`);

    // Upload all .ts segments
    for (const segPath of segmentFiles) {
      const segName = basename(segPath);
      const segKey = `${prefix}${segName}`;
      const segData = await Bun.file(segPath).arrayBuffer();
      await s3Client
        .file(segKey, { type: "video/mp2t" })
        .write(new Uint8Array(segData));
    }

    log(`Uploaded ${segmentFiles.length} HLS segments for channel ${channelNumber}`);

    // Return public URL to m3u8
    return buildS3Url(m3u8Key);
  } catch (err) {
    log(`Failed to upload HLS to S3: ${err}`);
    return null;
  }
}

/**
 * Upload peaks JSON to S3
 */
async function uploadPeaksToS3(
  peaksPath: string,
  sessionId: string,
  channelNumber: number
): Promise<string | null> {
  if (!s3Client || !config.s3.enabled) return null;

  const padded = String(channelNumber).padStart(2, "0");
  const s3Key = `${config.s3.peaksPrefix}${sessionId}/channel_${padded}_peaks.json`;

  try {
    const data = await Bun.file(peaksPath).arrayBuffer();
    await s3Client
      .file(s3Key, { type: "application/json" })
      .write(new Uint8Array(data));

    log(`Uploaded peaks: ${s3Key}`);
    return buildS3Url(s3Key);
  } catch (err) {
    log(`Failed to upload peaks to S3: ${err}`);
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

  // Pre-fetch all FLAC segments in parallel (downloads from S3 if needed)
  const flacSegments = await prefetchFlacSegments(channelNumber, segmentsByNumber);

  if (flacSegments.size === 0) {
    log(`Warning: No segments found for channel ${channelNumber}`);
    return;
  }

  // Extract channel from each segment (in order)
  const extractedFiles: string[] = [];
  const sortedSegNums = Array.from(flacSegments.keys()).sort((a, b) => a - b);

  for (const segNum of sortedSegNums) {
    const { channelIndex, flacPath } = flacSegments.get(segNum)!;

    // Extract channel to temp file
    const extractedPath = join(tempDir, `seg${segNum}_ch${channelNumber}.flac`);

    await extractChannelFromFlac(flacPath, channelIndex, extractedPath);
    extractedFiles.push(extractedPath);
  }

  if (extractedFiles.length === 0) {
    log(`Warning: No segments extracted for channel ${channelNumber}`);
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

  // Upload MP3 to S3
  const s3Result = await uploadMp3ToS3(mp3Path, session.id, channelNumber);

  // Generate peaks JSON
  const sessionDir = join(config.localStorage.dir, session.id);
  const peaksDir = join(sessionDir, "peaks");
  await mkdir(peaksDir, { recursive: true });
  const padded = String(channelNumber).padStart(2, "0");
  const peaksPath = join(peaksDir, `channel_${padded}_peaks.json`);

  let peaksUrl: string | null = null;
  try {
    await generatePeaks(mp3Path, peaksPath);
    peaksUrl = await uploadPeaksToS3(peaksPath, session.id, channelNumber);
  } catch (err) {
    log(`Warning: Failed to generate peaks for channel ${channelNumber}: ${err}`);
  }

  // Generate HLS segments
  const hlsDir = join(sessionDir, "hls");
  await mkdir(hlsDir, { recursive: true });

  let hlsUrl: string | null = null;
  try {
    const { m3u8Path, segmentFiles } = await generateHls(mp3Path, hlsDir, channelNumber);
    hlsUrl = await uploadHlsToS3(m3u8Path, segmentFiles, session.id, channelNumber);
  } catch (err) {
    log(`Warning: Failed to generate HLS for channel ${channelNumber}: ${err}`);
  }

  // Record in database with all URLs
  const channel = insertProcessedChannel(
    session.id,
    channelNumber,
    mp3Path,
    fileSize,
    s3Result?.s3Key,
    s3Result?.s3Url,
    durationSeconds,
    hlsUrl ?? undefined,
    peaksUrl ?? undefined,
    audioStats?.isQuiet ?? false
  );

  if (s3Result) {
    updateProcessedChannelS3(channel.id, s3Result.s3Key, s3Result.s3Url);
  }

  log(`Completed channel ${channelNumber}: MP3=${!!s3Result}, HLS=${!!hlsUrl}, Peaks=${!!peaksUrl}, Quiet=${audioStats?.isQuiet ?? false}`);
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

/**
 * Check if audiowaveform is available
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
 * Download MP3 from S3 URL to local path
 */
async function downloadMp3FromS3(s3Url: string, localPath: string): Promise<void> {
  log(`Downloading MP3 from S3: ${s3Url} -> ${localPath}`);

  // Ensure directory exists
  const dir = dirname(localPath);
  await mkdir(dir, { recursive: true });

  // Fetch from S3 URL
  const response = await fetch(s3Url);
  if (!response.ok) {
    throw new Error(`Failed to download: HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.arrayBuffer();
  await Bun.write(localPath, new Uint8Array(data));

  log(`Downloaded MP3: ${localPath} (${(data.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

/**
 * Download FLAC segment from S3 to local path
 */
async function downloadFlacFromS3(s3Key: string, localPath: string): Promise<void> {
  const s3Url = buildS3Url(s3Key);
  log(`Downloading FLAC from S3: ${s3Url} -> ${localPath}`);

  // Ensure directory exists
  const dir = dirname(localPath);
  await mkdir(dir, { recursive: true });

  // Fetch from S3 URL
  const response = await fetch(s3Url);
  if (!response.ok) {
    throw new Error(`Failed to download FLAC: HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.arrayBuffer();
  await Bun.write(localPath, new Uint8Array(data));

  log(`Downloaded FLAC: ${localPath} (${(data.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

/**
 * Ensure FLAC segment is available locally, downloading from S3 if needed
 * Returns the local path if successful, null if unavailable
 */
async function ensureFlacAvailable(segment: Segment): Promise<string | null> {
  const flacPath = segment.local_path;
  const flacFile = Bun.file(flacPath);

  // Check if file exists locally
  if (await flacFile.exists()) {
    return flacPath;
  }

  // Try to download from S3 if we have an s3_key
  if (segment.s3_key) {
    try {
      log(`FLAC segment not found locally, downloading from S3: ${segment.s3_key}`);
      await downloadFlacFromS3(segment.s3_key, flacPath);
      
      // Verify download succeeded
      const downloadedFile = Bun.file(flacPath);
      if (await downloadedFile.exists()) {
        return flacPath;
      }
    } catch (err) {
      log(`Failed to download FLAC from S3: ${err}`);
    }
  } else {
    log(`FLAC segment not found and no S3 key available: ${flacPath}`);
  }

  return null;
}

/**
 * Pre-fetch all FLAC segments in parallel for a channel
 * Returns a map of segment number to { segment, channelIndex, flacPath }
 */
async function prefetchFlacSegments(
  channelNumber: number,
  segmentsByNumber: Map<number, Segment[]>,
  concurrency: number = 5
): Promise<Map<number, { segment: Segment; channelIndex: number; flacPath: string }>> {
  const results = new Map<number, { segment: Segment; channelIndex: number; flacPath: string }>();
  const segmentNumbers = Array.from(segmentsByNumber.keys()).sort((a, b) => a - b);

  // First, identify all segments we need
  const segmentsToFetch: Array<{ segNum: number; segment: Segment; channelIndex: number }> = [];

  for (const segNum of segmentNumbers) {
    const segsForNumber = segmentsByNumber.get(segNum)!;

    // Find which segment file contains this channel
    for (const seg of segsForNumber) {
      const idx = getChannelIndexInGroup(channelNumber, seg.channel_group);
      if (idx >= 0) {
        segmentsToFetch.push({ segNum, segment: seg, channelIndex: idx });
        break;
      }
    }
  }

  if (segmentsToFetch.length === 0) {
    return results;
  }

  // Check which ones need downloading vs already exist locally
  const needsDownload: typeof segmentsToFetch = [];
  const alreadyLocal: typeof segmentsToFetch = [];

  await Promise.all(
    segmentsToFetch.map(async (item) => {
      const flacFile = Bun.file(item.segment.local_path);
      if (await flacFile.exists()) {
        alreadyLocal.push(item);
      } else if (item.segment.s3_key) {
        needsDownload.push(item);
      }
    })
  );

  // Add already-local segments to results
  for (const item of alreadyLocal) {
    results.set(item.segNum, {
      segment: item.segment,
      channelIndex: item.channelIndex,
      flacPath: item.segment.local_path,
    });
  }

  if (needsDownload.length > 0) {
    log(`Downloading ${needsDownload.length} FLAC segments from S3 (concurrency: ${concurrency})...`);

    // Download in parallel with concurrency limit
    const downloadBatches: typeof needsDownload[] = [];
    for (let i = 0; i < needsDownload.length; i += concurrency) {
      downloadBatches.push(needsDownload.slice(i, i + concurrency));
    }

    for (const batch of downloadBatches) {
      const downloadResults = await Promise.allSettled(
        batch.map(async (item) => {
          const flacPath = await ensureFlacAvailable(item.segment);
          return { item, flacPath };
        })
      );

      for (const result of downloadResults) {
        if (result.status === "fulfilled" && result.value.flacPath) {
          const { item, flacPath } = result.value;
          results.set(item.segNum, {
            segment: item.segment,
            channelIndex: item.channelIndex,
            flacPath,
          });
        }
      }
    }

    log(`Downloaded ${results.size - alreadyLocal.length} FLAC segments successfully`);
  }

  return results;
}

/**
 * Regenerate HLS and peaks for a processed session
 * Used for sessions that were processed before HLS/peaks were added
 * Will download MP3 from S3 if local file doesn't exist
 */
export async function regenerateHlsAndPeaks(sessionId: string): Promise<{
  success: boolean;
  channelsProcessed: number;
  errors: string[];
}> {
  log(`Regenerating HLS and peaks for session: ${sessionId}`);

  const session = getSession(sessionId);
  if (!session) {
    return { success: false, channelsProcessed: 0, errors: ["Session not found"] };
  }

  if (session.status !== "processed") {
    return { success: false, channelsProcessed: 0, errors: ["Session must be in 'processed' status"] };
  }

  const channels = getProcessedChannels(sessionId);
  if (channels.length === 0) {
    return { success: false, channelsProcessed: 0, errors: ["No processed channels found"] };
  }

  const sessionDir = join(config.localStorage.dir, sessionId);
  const mp3Dir = join(sessionDir, "mp3");
  const peaksDir = join(sessionDir, "peaks");
  const hlsDir = join(sessionDir, "hls");

  await mkdir(mp3Dir, { recursive: true });
  await mkdir(peaksDir, { recursive: true });
  await mkdir(hlsDir, { recursive: true });

  const errors: string[] = [];
  let channelsProcessed = 0;

  for (const channel of channels) {
    const channelNumber = channel.channel_number;
    const padded = String(channelNumber).padStart(2, "0");
    let mp3Path = channel.local_path;

    // Check if MP3 exists locally
    let mp3File = Bun.file(mp3Path);
    if (!(await mp3File.exists())) {
      // Try to download from S3 if we have a URL
      if (channel.s3_url) {
        try {
          // Update mp3Path to the expected location
          mp3Path = join(mp3Dir, `channel_${padded}.mp3`);
          await downloadMp3FromS3(channel.s3_url, mp3Path);
          mp3File = Bun.file(mp3Path);
        } catch (err) {
          errors.push(`Channel ${channelNumber}: Failed to download MP3 from S3 - ${err}`);
          continue;
        }
      } else {
        errors.push(`Channel ${channelNumber}: MP3 file not found locally and no S3 URL available`);
        continue;
      }
    }

    let peaksUrl: string | null = channel.peaks_url;
    let hlsUrl: string | null = channel.hls_url;

    // Generate peaks if missing
    if (!peaksUrl) {
      try {
        const peaksPath = join(peaksDir, `channel_${padded}_peaks.json`);
        await generatePeaks(mp3Path, peaksPath);
        peaksUrl = await uploadPeaksToS3(peaksPath, sessionId, channelNumber);
        log(`Generated peaks for channel ${channelNumber}`);
      } catch (err) {
        errors.push(`Channel ${channelNumber}: Failed to generate peaks - ${err}`);
      }
    }

    // Generate HLS if missing
    if (!hlsUrl) {
      try {
        const { m3u8Path, segmentFiles } = await generateHls(mp3Path, hlsDir, channelNumber);
        hlsUrl = await uploadHlsToS3(m3u8Path, segmentFiles, sessionId, channelNumber);
        log(`Generated HLS for channel ${channelNumber}`);
      } catch (err) {
        errors.push(`Channel ${channelNumber}: Failed to generate HLS - ${err}`);
      }
    }

    // Update database if we generated anything new
    if (peaksUrl !== channel.peaks_url || hlsUrl !== channel.hls_url) {
      updateProcessedChannelHlsAndPeaks(channel.id, hlsUrl, peaksUrl);
      channelsProcessed++;
    }
  }

  const success = errors.length === 0 || channelsProcessed > 0;
  log(`Regeneration complete: ${channelsProcessed} channels updated, ${errors.length} errors`);

  return { success, channelsProcessed, errors };
}

/**
 * Regenerate MP3 for a single channel from original FLAC segments
 * Applies normalization and updates HLS/peaks
 */
export async function regenerateMp3ForChannel(
  sessionId: string,
  channelNumber: number
): Promise<{ success: boolean; error?: string }> {
  log(`Regenerating MP3 for session ${sessionId}, channel ${channelNumber}`);

  const session = getSession(sessionId);
  if (!session) {
    return { success: false, error: "Session not found" };
  }

  if (session.status !== "processed") {
    return { success: false, error: "Session must be in 'processed' status" };
  }

  // Get segments for this session
  const segments = getSessionSegments(sessionId);
  if (segments.length === 0) {
    return { success: false, error: "No segments found for session" };
  }

  const sessionDir = join(config.localStorage.dir, sessionId);
  const mp3Dir = join(sessionDir, "mp3");
  const tempDir = join(sessionDir, "temp");
  const peaksDir = join(sessionDir, "peaks");
  const hlsDir = join(sessionDir, "hls");

  await mkdir(mp3Dir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(peaksDir, { recursive: true });
  await mkdir(hlsDir, { recursive: true });

  try {
    // Group segments by segment number
    const segmentsByNumber = new Map<number, Segment[]>();
    for (const segment of segments) {
      const existing = segmentsByNumber.get(segment.segment_number) || [];
      existing.push(segment);
      segmentsByNumber.set(segment.segment_number, existing);
    }

    // Pre-fetch all FLAC segments in parallel (downloads from S3 if needed)
    const flacSegments = await prefetchFlacSegments(channelNumber, segmentsByNumber);

    if (flacSegments.size === 0) {
      return { success: false, error: "No FLAC segments found locally or on S3 for this channel" };
    }

    // Extract channel from each segment (in order)
    const extractedFiles: string[] = [];
    const sortedSegNums = Array.from(flacSegments.keys()).sort((a, b) => a - b);

    for (const segNum of sortedSegNums) {
      const { channelIndex, flacPath } = flacSegments.get(segNum)!;

      // Extract channel to temp file
      const extractedPath = join(tempDir, `regen_seg${segNum}_ch${channelNumber}.flac`);
      await extractChannelFromFlac(flacPath, channelIndex, extractedPath);
      extractedFiles.push(extractedPath);
    }

    if (extractedFiles.length === 0) {
      return { success: false, error: "No FLAC segments could be extracted" };
    }

    // Analyze audio
    const audioStats = await analyzeAudio(extractedFiles[0]);
    log(`  Channel ${channelNumber} audio stats: max=${audioStats.maxVolume.toFixed(1)}dB, mean=${audioStats.meanVolume.toFixed(1)}dB, quiet=${audioStats.isQuiet}`);

    // Encode to MP3 with normalization
    const padded = String(channelNumber).padStart(2, "0");
    const mp3Path = join(mp3Dir, `channel_${padded}.mp3`);

    const { fileSize, durationSeconds } = await concatenateAndEncodeToMp3(
      extractedFiles,
      mp3Path,
      tempDir,
      audioStats
    );

    log(`Regenerated MP3: ${mp3Path} (${(fileSize / 1024 / 1024).toFixed(2)} MB, ${durationSeconds.toFixed(1)}s)`);

    // Clean up extracted temp files
    for (const file of extractedFiles) {
      await unlink(file).catch(() => {});
    }

    // Upload MP3 to S3
    const s3Result = await uploadMp3ToS3(mp3Path, sessionId, channelNumber);

    // Regenerate peaks
    const peaksPath = join(peaksDir, `channel_${padded}_peaks.json`);
    let peaksUrl: string | null = null;
    try {
      await generatePeaks(mp3Path, peaksPath);
      peaksUrl = await uploadPeaksToS3(peaksPath, sessionId, channelNumber);
    } catch (err) {
      log(`Warning: Failed to regenerate peaks for channel ${channelNumber}: ${err}`);
    }

    // Regenerate HLS
    let hlsUrl: string | null = null;
    try {
      const { m3u8Path, segmentFiles } = await generateHls(mp3Path, hlsDir, channelNumber);
      hlsUrl = await uploadHlsToS3(m3u8Path, segmentFiles, sessionId, channelNumber);
    } catch (err) {
      log(`Warning: Failed to regenerate HLS for channel ${channelNumber}: ${err}`);
    }

    // Update database
    const channel = insertProcessedChannel(
      sessionId,
      channelNumber,
      mp3Path,
      fileSize,
      s3Result?.s3Key,
      s3Result?.s3Url,
      durationSeconds,
      hlsUrl ?? undefined,
      peaksUrl ?? undefined,
      audioStats.isQuiet
    );

    if (s3Result) {
      updateProcessedChannelS3(channel.id, s3Result.s3Key, s3Result.s3Url);
    }

    log(`Completed regeneration of channel ${channelNumber}`);
    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to regenerate channel ${channelNumber}: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Regenerate all MP3s for a session from original FLAC segments
 * Applies normalization and updates HLS/peaks for all channels
 */
export async function regenerateAllMp3s(sessionId: string): Promise<{
  success: boolean;
  results: Array<{ channel: number; success: boolean; error?: string }>;
}> {
  log(`Regenerating all MP3s for session: ${sessionId}`);

  const session = getSession(sessionId);
  if (!session) {
    return {
      success: false,
      results: [{ channel: 0, success: false, error: "Session not found" }],
    };
  }

  // Process all 18 channels
  const results: Array<{ channel: number; success: boolean; error?: string }> = [];

  for (let channelNumber = 1; channelNumber <= session.channels; channelNumber++) {
    const result = await regenerateMp3ForChannel(sessionId, channelNumber);
    results.push({
      channel: channelNumber,
      success: result.success,
      error: result.error,
    });
  }

  const successCount = results.filter((r) => r.success).length;
  const success = successCount > 0;

  log(`Regeneration complete: ${successCount}/${results.length} channels succeeded`);

  return { success, results };
}
