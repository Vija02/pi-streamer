/**
 * Configuration for XR18 Audio Sender Service
 */
import { formatTimestamp } from "./utils";

export interface Config {
  // Remote server endpoint
  streamUrl: string;

  // Local recording settings
  recordingDir: string;
  recordingFormat: string;

  // Audio settings
  sampleRate: number;
  channels: number;
  jackClientName: string;

  // JACK port prefix (adjust based on your JACK setup)
  jackPortPrefix: string;

  // Segment duration in seconds
  segmentDuration: number;

  // Session ID
  sessionId: string;

  // Upload settings
  uploadEnabled: boolean;
  uploadRetryCount: number;
  uploadRetryDelay: number;

  // Finish trigger file path
  finishTriggerPath: string;
}

export function loadConfig(): Config {
  return {
    // Remote server endpoint
    streamUrl: process.env.STREAM_URL || "http://localhost:3000/stream",

    // Local recording settings
    recordingDir: process.env.RECORDING_DIR || "./recordings",
    recordingFormat: process.env.RECORDING_FORMAT || "flac",

    // Audio settings
    sampleRate: Number(process.env.SAMPLE_RATE) || 48000,
    channels: Number(process.env.CHANNELS) || 18,
    jackClientName: process.env.JACK_CLIENT_NAME || "xr18_streamer",

    // JACK port prefix
    jackPortPrefix: process.env.JACK_PORT_PREFIX || "system:capture_",

    // Segment duration in seconds
    segmentDuration: Number(process.env.SEGMENT_DURATION) || 30,

    // Session ID
    sessionId: process.env.SESSION_ID || formatTimestamp(new Date()),

    // Upload settings
    uploadEnabled: process.env.UPLOAD_ENABLED !== "false",
    uploadRetryCount: Number(process.env.UPLOAD_RETRY_COUNT) || 3,
    uploadRetryDelay: Number(process.env.UPLOAD_RETRY_DELAY) || 5000,

    // Finish trigger - touch this file to gracefully stop recording
    finishTriggerPath: process.env.FINISH_TRIGGER_PATH || "/tmp/xr18-finish",
  };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
