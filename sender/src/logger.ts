/**
 * Pino logger configuration
 */
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

// Create child loggers for different modules
export const jackLogger = logger.child({ module: "jack" });
export const uploadLogger = logger.child({ module: "upload" });
export const recordingLogger = logger.child({ module: "recording" });
export const watcherLogger = logger.child({ module: "watcher" });
