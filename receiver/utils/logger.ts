/**
 * Structured Logger
 *
 * Provides consistent logging with module prefixes and timestamps.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(module: string, level: LogLevel, message: string): string {
  return `[${formatTimestamp()}] [${module}] [${level.toUpperCase()}] ${message}`;
}

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * Create a logger instance for a specific module
 */
export function createLogger(module: string): Logger {
  return {
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog("debug")) {
        console.debug(formatMessage(module, "debug", message), ...args);
      }
    },
    info: (message: string, ...args: unknown[]) => {
      if (shouldLog("info")) {
        console.log(formatMessage(module, "info", message), ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (shouldLog("warn")) {
        console.warn(formatMessage(module, "warn", message), ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      if (shouldLog("error")) {
        console.error(formatMessage(module, "error", message), ...args);
      }
    },
  };
}

/**
 * Simple log function for backward compatibility
 * @deprecated Use createLogger() instead for better module tracking
 */
export function log(message: string, ...args: unknown[]): void {
  console.log(`[${formatTimestamp()}] ${message}`, ...args);
}
