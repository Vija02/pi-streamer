/**
 * Centralized Configuration
 *
 * All configuration is loaded from environment variables with sensible defaults.
 * This is the single source of truth for all settings across the receiver.
 */

export const config = {
  port: Number(process.env.PORT) || 3000,

  // S3 Configuration
  s3: {
    enabled: process.env.S3_ENABLED !== "false",
    bucket: process.env.S3_BUCKET || "your-audio-bucket",
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT,
    publicUrl: process.env.S3_PUBLIC_URL,
    prefix: process.env.S3_PREFIX || "recordings/",
    hlsPrefix: process.env.S3_HLS_PREFIX || "hls/",
    peaksPrefix: process.env.S3_PEAKS_PREFIX || "peaks/",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
  },

  // Local storage configuration
  localStorage: {
    dir: process.env.LOCAL_STORAGE_DIR || "./received",
    dbPath: process.env.DB_PATH || "./data/receiver.db",
  },

  // Upload queue settings (for background S3 uploads)
  uploadQueue: {
    retryIntervalMs: Number(process.env.UPLOAD_RETRY_INTERVAL) || 5000,
    maxRetries: Number(process.env.UPLOAD_MAX_RETRIES) || 5,
    concurrency: Number(process.env.UPLOAD_CONCURRENCY) || 2,
  },

  // Audio processing settings
  processing: {
    mp3: {
      useVbr: process.env.MP3_USE_VBR !== "false",
      vbrQuality: Number(process.env.MP3_VBR_QUALITY) || 2,
      bitrate: process.env.MP3_BITRATE || "320k",
      quietChannelQuality: Number(process.env.QUIET_CHANNEL_VBR_QUALITY) || 7,
    },
    normalization: {
      enabled: process.env.NORMALIZE_ENABLED !== "false",
      targetLufs: Number(process.env.NORMALIZE_TARGET_LUFS ?? -16),
      targetTruePeak: Number(process.env.NORMALIZE_TRUE_PEAK ?? -1.5),
      targetLra: Number(process.env.NORMALIZE_LRA ?? 11),
    },
    analysis: {
      quietThresholdDb: Number(process.env.QUIET_CHANNEL_THRESHOLD_DB) || -40,
      silenceThresholdDb: Number(process.env.SILENCE_THRESHOLD_DB) || -50,
      silenceMinDuration: Number(process.env.SILENCE_MIN_DURATION) || 0.5,
    },
    hls: {
      segmentDuration: Number(process.env.HLS_SEGMENT_DURATION) || 10,
      audioBitrate: process.env.HLS_AUDIO_BITRATE || "128k",
    },
    peaks: {
      pixelsPerSecond: Number(process.env.PEAKS_PIXELS_PER_SECOND) || 50,
      bits: Number(process.env.PEAKS_BITS) || 8,
    },
    keepFlacAfterProcess: process.env.KEEP_FLAC_AFTER_PROCESS !== "false",
  },

  // Session management
  session: {
    timeoutMinutes: Number(process.env.SESSION_TIMEOUT_MINUTES) || 10,
    checkIntervalMs: Number(process.env.SESSION_CHECK_INTERVAL_MS) || 60000,
  },

  // Pipeline settings
  pipeline: {
    maxRetries: Number(process.env.PIPELINE_MAX_RETRIES) || 3,
    retryDelayMs: Number(process.env.PIPELINE_RETRY_DELAY_MS) || 1000,
    retryBackoffMultiplier: Number(process.env.PIPELINE_RETRY_BACKOFF) || 2,
    flacDownloadConcurrency: Number(process.env.FLAC_DOWNLOAD_CONCURRENCY) || 5,
  },
} as const;

export type Config = typeof config;
