/**
 * Database Module
 *
 * Re-exports all database functionality for convenient imports.
 *
 * Usage:
 *   import { initDatabase, getSession, insertSegment } from "./db";
 */

// Re-export connection management
export { initDatabase, getDatabase, closeDatabase, getDbPath } from "./connection";

// Re-export types
export * from "./types";

// Re-export query functions
export * from "./sessions";
export * from "./segments";
export * from "./channels";
export * from "./pipelineRuns";
export * from "./recordings";
