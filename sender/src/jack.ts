/**
 * JACK Audio utilities
 */
import { $, spawn, type Subprocess } from "bun";
import { getConfig } from "./config";
import { jackLogger as logger } from "./logger";

// JACK server configuration
const JACK_CONFIG = {
  driver: process.env.JACK_DRIVER || "alsa",
  device: process.env.JACK_DEVICE || "hw:XR18",
  sampleRate: Number(process.env.JACK_SAMPLE_RATE) || 48000,
  periodSize: Number(process.env.JACK_PERIOD_SIZE) || 2048,
  nPeriods: Number(process.env.JACK_NPERIODS) || 3,
  autoStart: process.env.JACK_AUTO_START !== "false", // Auto-start by default
  startupWaitMs: Number(process.env.JACK_STARTUP_WAIT_MS) || 3000, // Wait for JACK to initialize
};

// Track the JACK server process if we started it
let jackProcess: Subprocess<"ignore", "ignore", "pipe"> | null = null;
let jackWasAutoStarted = false;

/**
 * Check if JACK server is running
 */
export async function isJackRunning(): Promise<boolean> {
  try {
    await $`jack_lsp`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start JACK server with XR18 configuration
 * Returns true if JACK was started successfully or was already running
 */
export async function startJackServer(): Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }> {
  // Check if already running
  if (await isJackRunning()) {
    logger.info("JACK server is already running");
    return { ok: true, alreadyRunning: true };
  }

  logger.info({
    driver: JACK_CONFIG.driver,
    device: JACK_CONFIG.device,
    sampleRate: JACK_CONFIG.sampleRate,
    periodSize: JACK_CONFIG.periodSize,
    nPeriods: JACK_CONFIG.nPeriods,
  }, "Starting JACK server...");

  try {
    // Build jackd command arguments
    const args = [
      `-d${JACK_CONFIG.driver}`,
      `-d${JACK_CONFIG.device}`,
      `-r${JACK_CONFIG.sampleRate}`,
      `-p${JACK_CONFIG.periodSize}`,
      `-n${JACK_CONFIG.nPeriods}`,
    ];

    logger.debug({ command: `jackd ${args.join(" ")}` }, "JACK command");

    // Start jackd in background
    // We track this process so we can kill it on shutdown
    const proc = spawn(["jackd", ...args], {
      stdout: "ignore",
      stderr: "pipe", // Capture stderr for error detection
    });

    // Wait a bit for JACK to start up
    await new Promise((resolve) => setTimeout(resolve, JACK_CONFIG.startupWaitMs));

    // Check if JACK is now running
    if (await isJackRunning()) {
      logger.info("JACK server started successfully");
      // Store the process reference so we can clean it up later
      jackProcess = proc;
      jackWasAutoStarted = true;
      return { ok: true };
    }

    // If not running, try to get error from stderr
    const stderrReader = proc.stderr?.getReader();
    let errorMsg = "JACK failed to start (unknown reason)";
    
    if (stderrReader) {
      try {
        const { value } = await stderrReader.read();
        if (value) {
          errorMsg = new TextDecoder().decode(value).trim();
        }
      } catch {
        // Ignore read errors
      }
    }

    logger.error({ error: errorMsg }, "Failed to start JACK server");
    return { ok: false, error: errorMsg };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    logger.error({ error: errorMsg }, "Exception starting JACK server");
    return { ok: false, error: errorMsg };
  }
}

/**
 * List all JACK ports
 */
export async function jackLsp(): Promise<string[]> {
  try {
    const result = await $`jack_lsp`.text();
    return result.trim().split("\n").filter(Boolean);
  } catch {
    throw new Error("JACK server is not running. Start JACK first.");
  }
}

/**
 * Connect two JACK ports
 */
export async function jackConnect(src: string, dst: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await $`jack_connect ${src} ${dst}`.quiet();
    return { ok: true };
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() || err?.message || String(err);
    return { ok: false, error: stderr.trim() };
  }
}

export interface JackCheckResult {
  ok: boolean;
  ports: string[];
  wasStarted?: boolean; // true if JACK was auto-started
}

/**
 * Check if JACK is running and has the expected capture ports.
 * If JACK is not running and auto-start is enabled, will attempt to start it.
 */
export async function checkJackSetup(): Promise<JackCheckResult> {
  const config = getConfig();

  // First check if JACK is running
  if (!(await isJackRunning())) {
    if (JACK_CONFIG.autoStart) {
      logger.info("JACK not running, attempting to auto-start...");
      const startResult = await startJackServer();
      
      if (!startResult.ok) {
        logger.error({ error: startResult.error }, "Failed to auto-start JACK server");
        return { ok: false, ports: [] };
      }
      
      // JACK was started, continue with port check
      try {
        const ports = await jackLsp();
        const capturePrefix = config.jackPortPrefix;
        const capturePorts = ports.filter((p) => p.startsWith(capturePrefix));

        if (capturePorts.length < config.channels) {
          logger.warn(
            { found: capturePorts.length, expected: config.channels, prefix: capturePrefix },
            "Found fewer ports than expected"
          );
          logger.info({ ports }, "Available JACK ports");
          logger.info("Set JACK_PORT_PREFIX to match your XR18 ports");
        }

        return { ok: true, ports: capturePorts, wasStarted: !startResult.alreadyRunning };
      } catch (err) {
        logger.error({ err }, "Failed to list JACK ports after starting server");
        return { ok: false, ports: [] };
      }
    } else {
      logger.error("JACK not running and auto-start is disabled (JACK_AUTO_START=false)");
      return { ok: false, ports: [] };
    }
  }

  // JACK is already running, check ports
  try {
    const ports = await jackLsp();
    const capturePrefix = config.jackPortPrefix;
    const capturePorts = ports.filter((p) => p.startsWith(capturePrefix));

    if (capturePorts.length < config.channels) {
      logger.warn(
        { found: capturePorts.length, expected: config.channels, prefix: capturePrefix },
        "Found fewer ports than expected"
      );
      logger.info({ ports }, "Available JACK ports");
      logger.info("Set JACK_PORT_PREFIX to match your XR18 ports");
    }

    return { ok: true, ports: capturePorts };
  } catch (err) {
    logger.error({ err }, "Failed to check JACK setup");
    return { ok: false, ports: [] };
  }
}

/**
 * Get source ports matching the configured prefix
 * (used by jack_capture to know which ports to record)
 */
export async function getSourcePorts(): Promise<string[]> {
  const config = getConfig();
  const allPorts = await jackLsp();
  return allPorts.filter((p) => p.startsWith(config.jackPortPrefix));
}

/**
 * Get capture ports that match filter criteria
 */
export async function getCapturePorts(): Promise<string[]> {
  const ports = await jackLsp();
  return ports.filter(
    (p) => p.toLowerCase().includes("capture") || p.includes(":in")
  );
}

/**
 * Check if JACK was auto-started by this process
 */
export function wasJackAutoStarted(): boolean {
  return jackWasAutoStarted;
}

/**
 * Stop the JACK server if it was auto-started by this process
 */
export async function stopJackServer(): Promise<void> {
  if (!jackProcess || !jackWasAutoStarted) {
    return;
  }

  logger.info("Stopping JACK server (was auto-started)");
  
  try {
    jackProcess.kill("SIGTERM");
    
    // Wait for the process to exit with a timeout
    const exitPromise = jackProcess.exited;
    const timeoutPromise = new Promise<number>((resolve) => 
      setTimeout(() => resolve(-1), 5000)
    );
    
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    
    if (exitCode === -1) {
      // Timeout - force kill
      logger.warn("JACK server did not exit gracefully, force killing");
      jackProcess.kill("SIGKILL");
    } else {
      logger.info({ exitCode }, "JACK server stopped");
    }
  } catch (err) {
    logger.warn({ err }, "Error stopping JACK server");
  } finally {
    jackProcess = null;
    jackWasAutoStarted = false;
  }
}
