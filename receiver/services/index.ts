/**
 * Services Module
 *
 * Exports all service functionality.
 */

// Storage service
export {
  getS3Client,
  isS3Enabled,
  ensureDir,
  saveLocalFile,
  readLocalFile,
  localFileExists,
  getLocalFileSize,
  deleteLocalFile,
  listFiles,
  uploadToS3,
  uploadFileToS3,
  downloadFromS3,
  downloadFromS3ToFile,
  CONTENT_TYPES,
  getContentType,
  getOrCreateSessionDir,
  listSessionDirs,
  deleteSessionFiles,
} from "./storage";

// Upload queue service
export {
  addToUploadQueue,
  retryFailedUploads,
  getUploadQueueStatus,
  clearUploadQueue,
  type UploadQueueItem,
} from "./uploadQueue";

// Session service
export {
  markSessionComplete,
  startSessionManager,
  stopSessionManager,
  getSessionManagerStatus,
  triggerProcessing,
  getProcessingQueue,
  isSessionQueued,
  removeFromQueue,
} from "./session";
