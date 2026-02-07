/**
 * Utility functions
 */
import { $ } from "bun";

/**
 * Format a date as a compact timestamp string
 * Example: 20260206T163045
 */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 15);
}

/**
 * Check if a command exists in the system PATH
 */
export async function commandExists(cmd: string): Promise<boolean> {
  try {
    await $`which ${cmd}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}
