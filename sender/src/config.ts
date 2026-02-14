/**
 * Configuration for XR18 Audio Sender Service
 */
import { formatTimestamp } from "./utils";

export interface Config {
  // Remote server endpoint
  streamUrl: string;

  // Local recording settings
  recordingDir: string;

  // Audio settings
  sampleRate: number;
  channels: number;

  // JACK port prefix (adjust based on your JACK setup)
  jackPortPrefix: string;

  // Laptop audio routing to XR18
  laptopRouteEnabled: boolean;
  laptopCaptureLeft: string;
  laptopCaptureRight: string;
  xr18PlaybackLeft: string;
  xr18PlaybackRight: string;

  // Segment duration in seconds
  segmentDuration: number;

  // Session ID
  sessionId: string;

  // Upload settings
  uploadEnabled: boolean;
  uploadRetryCount: number;
  uploadRetryDelay: number;

  // Compression settings
  compressionEnabled: boolean;
  deleteAfterCompress: boolean;

  // Finish trigger file path
  finishTriggerPath: string;
}

export function loadConfig(): Config {
  return {
    // Remote server endpoint
    streamUrl: process.env.STREAM_URL || "http://localhost:3000/stream",

    // Local recording settings
    recordingDir: process.env.RECORDING_DIR || "./recordings",

    // Audio settings
    sampleRate: Number(process.env.SAMPLE_RATE) || 48000,
    channels: Number(process.env.CHANNELS) || 18,

    // JACK port prefix
    jackPortPrefix: process.env.JACK_PORT_PREFIX || "XR18 Multichannel:capture_AUX",

    // Laptop audio routing to XR18 (connects laptop output to XR18 input channel 10)
    laptopRouteEnabled: process.env.LAPTOP_ROUTE_ENABLED !== "false",
    laptopCaptureLeft: process.env.LAPTOP_CAPTURE_LEFT || "Built-in Audio Analog Stereo:capture_FL",
    laptopCaptureRight: process.env.LAPTOP_CAPTURE_RIGHT || "Built-in Audio Analog Stereo:capture_FR",
    xr18PlaybackLeft: process.env.XR18_PLAYBACK_LEFT || "XR18 Multichannel:playback_AUX9",
    xr18PlaybackRight: process.env.XR18_PLAYBACK_RIGHT || "XR18 Multichannel:playback_AUX9",

    // Segment duration in seconds
    segmentDuration: Number(process.env.SEGMENT_DURATION) || 30,

    // Session ID
    sessionId: process.env.SESSION_ID || formatTimestamp(new Date()),

    // Upload settings
    uploadEnabled: process.env.UPLOAD_ENABLED !== "false",
    uploadRetryCount: Number(process.env.UPLOAD_RETRY_COUNT) || 3,
    uploadRetryDelay: Number(process.env.UPLOAD_RETRY_DELAY) || 5000,

    // Compression settings
    compressionEnabled: process.env.COMPRESSION_ENABLED !== "false",
    deleteAfterCompress: process.env.DELETE_AFTER_COMPRESS !== "false",

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
