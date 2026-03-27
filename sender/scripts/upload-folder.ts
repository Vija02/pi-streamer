#!/usr/bin/env bun
/**
 * Upload a recording folder to the receiver
 * 
 * Usage:
 *   bun run scripts/upload-folder.ts <folder-path-or-session-id>
 * 
 * Examples:
 *   bun run scripts/upload-folder.ts ./recordings/2024-02-07_12-30-00
 *   bun run scripts/upload-folder.ts 2024-02-07_12-30-00
 * 
 * Environment variables:
 *   STREAM_URL - Receiver endpoint (default: http://localhost:3000/stream)
 *   SAMPLE_RATE - Sample rate (default: 48000)
 *   CHANNELS - Number of channels (default: 18)
 *   RECORDING_DIR - Base recordings directory (default: ./recordings)
 */

import { join, basename, isAbsolute } from "path";

interface UploadResult {
  file: string;
  success: boolean;
  error?: string;
}

// Configuration from environment
const config = {
  streamUrl: process.env.STREAM_URL || "http://localhost:3000/stream",
  sampleRate: Number(process.env.SAMPLE_RATE) || 48000,
  channels: Number(process.env.CHANNELS) || 18,
  recordingDir: process.env.RECORDING_DIR || "./recordings",
};

/**
 * Extract segment number from filename
 * e.g., "segment_00_ch01-06.flac" -> 0
 */
function extractSegmentNumber(filename: string): number {
  const match = filename.match(/segment_(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extract channel group from filename
 * e.g., "segment_00_ch01-06.flac" -> "ch01-06"
 */
function extractChannelGroup(filename: string): string | undefined {
  const match = filename.match(/(ch\d+-\d+)/);
  return match ? match[1] : undefined;
}

/**
 * Upload a single file to the receiver
 */
async function uploadFile(
  filePath: string,
  sessionId: string
): Promise<UploadResult> {
  const fileName = basename(filePath);
  const segmentNumber = extractSegmentNumber(fileName);
  const channelGroup = extractChannelGroup(fileName);

  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return { file: fileName, success: false, error: "File not found" };
    }

    const fileData = await file.arrayBuffer();

    // Determine content type based on file extension
    const ext = filePath.split(".").pop()?.toLowerCase();
    const contentType = ext === "flac" ? "audio/flac" : "audio/wav";

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-Session-ID": sessionId,
      "X-Segment-Number": String(segmentNumber),
      "X-Sample-Rate": String(config.sampleRate),
      "X-Channels": String(config.channels),
    };

    // Add channel group header if present
    if (channelGroup) {
      headers["X-Channel-Group"] = channelGroup;
    }

    const response = await fetch(config.streamUrl, {
      method: "POST",
      headers,
      body: fileData,
    });

    if (response.ok) {
      return { file: fileName, success: true };
    } else {
      const text = await response.text();
      return {
        file: fileName,
        success: false,
        error: `HTTP ${response.status}: ${text}`,
      };
    }
  } catch (err) {
    return {
      file: fileName,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Find all FLAC files in a directory
 */
async function findFlacFiles(folderPath: string): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob("*.flac");

  for await (const file of glob.scan(folderPath)) {
    files.push(join(folderPath, file));
  }

  // Sort by segment number then channel group for consistent ordering
  files.sort((a, b) => {
    const aNum = extractSegmentNumber(basename(a));
    const bNum = extractSegmentNumber(basename(b));
    if (aNum !== bNum) return aNum - bNum;
    return basename(a).localeCompare(basename(b));
  });

  return files;
}

/**
 * Main upload function
 */
async function uploadFolder(folderArg: string): Promise<void> {
  // Resolve folder path
  let folderPath: string;
  if (isAbsolute(folderArg)) {
    folderPath = folderArg;
  } else if (folderArg.includes("/")) {
    // Relative path with directory separator
    folderPath = join(process.cwd(), folderArg);
  } else {
    // Assume it's a session ID, look in recordings directory
    folderPath = join(config.recordingDir, folderArg);
  }

  // Check if folder exists
  const folder = Bun.file(folderPath);
  const stat = await Bun.file(join(folderPath, ".")).exists().catch(() => false);
  
  // Try listing directory to verify it exists
  const files = await findFlacFiles(folderPath);
  
  if (files.length === 0) {
    console.error(`No FLAC files found in: ${folderPath}`);
    console.error("\nMake sure the folder exists and contains .flac files.");
    process.exit(1);
  }

  // Extract session ID from folder name
  const sessionId = basename(folderPath);

  console.log(`\nUpload Session Folder`);
  console.log(`=====================`);
  console.log(`Folder: ${folderPath}`);
  console.log(`Session ID: ${sessionId}`);
  console.log(`Receiver: ${config.streamUrl}`);
  console.log(`Files to upload: ${files.length}`);
  console.log(`\nStarting upload...\n`);

  const results: UploadResult[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const filePath of files) {
    const fileName = basename(filePath);
    process.stdout.write(`  Uploading ${fileName}... `);

    const result = await uploadFile(filePath, sessionId);
    results.push(result);

    if (result.success) {
      console.log("OK");
      successCount++;
    } else {
      console.log(`FAILED: ${result.error}`);
      failCount++;
    }
  }

  console.log(`\n=====================`);
  console.log(`Upload Complete`);
  console.log(`  Success: ${successCount}/${files.length}`);
  console.log(`  Failed: ${failCount}/${files.length}`);

  if (failCount > 0) {
    console.log(`\nFailed files:`);
    for (const result of results) {
      if (!result.success) {
        console.log(`  - ${result.file}: ${result.error}`);
      }
    }
    process.exit(1);
  }
}

// Main entry point
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
Upload Recording Folder to Receiver

Usage:
  bun run scripts/upload-folder.ts <folder-path-or-session-id>

Arguments:
  folder-path-or-session-id   Path to the recording folder, or just the session ID
                              (which will be looked up in RECORDING_DIR)

Examples:
  bun run scripts/upload-folder.ts ./recordings/2024-02-07_12-30-00
  bun run scripts/upload-folder.ts 2024-02-07_12-30-00
  bun run scripts/upload-folder.ts /absolute/path/to/session

Environment Variables:
  STREAM_URL      Receiver endpoint (default: http://localhost:3000/stream)
  SAMPLE_RATE     Audio sample rate (default: 48000)
  CHANNELS        Number of channels (default: 18)
  RECORDING_DIR   Base recordings directory (default: ./recordings)

This script uploads all FLAC files from a recording session to the receiver.
Use it to retry failed uploads or to manually upload a session.
`);
  process.exit(0);
}

uploadFolder(args[0]).catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
