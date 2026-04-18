/**
 * JACK Audio utilities
 */
import { $, spawn, type Subprocess } from "bun";
import { getConfig, updateDetectedConsole } from "./config";
import { jackLogger as logger } from "./logger";

// Known Behringer X-series mixer identifiers (as they appear in ALSA card names)
// These may appear as exact matches or substrings (e.g., "X18XR18" contains both "X18" and "XR18")
const KNOWN_MIXER_PATTERNS = [
  /\bXR18\b/i,
  /\bX18/i,      // Matches X18, X18XR18, etc.
  /\bXR16\b/i,
  /\bXR12\b/i,
  /\bX32\b/i,
  /\bX-USB\b/i,
];

// JACK server configuration
const JACK_CONFIG = {
  driver: process.env.JACK_DRIVER || "alsa",
  device: process.env.JACK_DEVICE || "auto",
  sampleRate: Number(process.env.JACK_SAMPLE_RATE) || 48000,
  periodSize: Number(process.env.JACK_PERIOD_SIZE) || 2048,
  nPeriods: Number(process.env.JACK_NPERIODS) || 3,
  autoStart: process.env.JACK_AUTO_START !== "false", // Auto-start by default
  startupWaitMs: Number(process.env.JACK_STARTUP_WAIT_MS) || 3000, // Wait for JACK to initialize
};

// Detected console info
let detectedConsoleName: string | null = null;

/**
 * Get the detected console name (e.g., "XR18", "X18XR18")
 */
export function getDetectedConsoleName(): string | null {
  return detectedConsoleName;
}

/**
 * Detect Behringer mixer ALSA device by scanning available sound cards.
 * Returns the ALSA hw: device string (e.g., "hw:XR18", "hw:X18XR18") or null if not found.
 */
export async function detectAlsaDevice(): Promise<{ device: string; cardName: string } | null> {
  try {
    const output = await $`aplay -l`.text();
    // Parse lines like: "card 1: XR18 [XR18], device 0: USB Audio [USB Audio]"
    //                or: "card 2: X18XR18 [X18XR18], device 0: USB Audio [USB Audio]"
    const cardRegex = /^card\s+\d+:\s+(\S+)\s+\[/gm;
    let match;
    while ((match = cardRegex.exec(output)) !== null) {
      const cardName = match[1];
      if (KNOWN_MIXER_PATTERNS.some((pattern) => pattern.test(cardName))) {
        logger.info({ cardName }, "Detected Behringer mixer ALSA device");
        return { device: `hw:${cardName}`, cardName };
      }
    }
  } catch (err) {
    logger.debug({ err }, "Failed to run aplay -l for device detection");
  }
  return null;
}

/**
 * Auto-detect the JACK port prefix by finding capture ports from a Behringer mixer.
 * Looks for ports matching patterns like "XR18 Multichannel:capture_AUX0"
 * Returns the prefix (everything before the channel number) or null.
 */
export async function detectPortPrefix(): Promise<{ prefix: string; consoleName: string } | null> {
  try {
    const ports = await jackLsp();
    // Look for capture ports from known mixer patterns
    // Port names look like: "XR18 Multichannel:capture_AUX0" or "X18XR18 Multichannel:capture_AUX0"
    const capturePortRegex = /^(.+\s+Multichannel:capture_AUX)\d+$/;

    for (const port of ports) {
      const match = capturePortRegex.exec(port);
      if (match) {
        const prefix = match[1];
        // Extract the console name (everything before " Multichannel:")
        const consoleName = prefix.split(" Multichannel:")[0];
        logger.info({ prefix, consoleName }, "Auto-detected JACK port prefix");
        return { prefix, consoleName };
      }
    }
  } catch (err) {
    logger.debug({ err }, "Failed to detect port prefix");
  }
  return null;
}

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
 * Start JACK server with auto-detected or configured mixer device
 * Returns true if JACK was started successfully or was already running
 */
export async function startJackServer(): Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }> {
  // Check if already running
  if (await isJackRunning()) {
    logger.info("JACK server is already running");
    return { ok: true, alreadyRunning: true };
  }

  // Resolve the device - auto-detect if set to "auto"
  let device = JACK_CONFIG.device;
  if (device === "auto") {
    const detected = await detectAlsaDevice();
    if (detected) {
      device = detected.device;
      detectedConsoleName = detected.cardName;
      updateDetectedConsole(detected.cardName);
    } else {
      logger.error("No Behringer mixer detected. Connect a mixer or set JACK_DEVICE explicitly.");
      return { ok: false, error: "No Behringer mixer detected via ALSA" };
    }
  }

  logger.info({
    driver: JACK_CONFIG.driver,
    device,
    sampleRate: JACK_CONFIG.sampleRate,
    periodSize: JACK_CONFIG.periodSize,
    nPeriods: JACK_CONFIG.nPeriods,
  }, "Starting JACK server...");

  try {
    // Build jackd command arguments
    const args = [
      `-d${JACK_CONFIG.driver}`,
      `-d${device}`,
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
 * Auto-detect and update the port prefix if configured to "auto".
 * Called after JACK is confirmed running.
 */
async function resolvePortPrefix(): Promise<string> {
  const config = getConfig();

  if (config.jackPortPrefix !== "auto") {
    return config.jackPortPrefix;
  }

  const detected = await detectPortPrefix();
  if (detected) {
    detectedConsoleName = detected.consoleName;
    updateDetectedConsole(detected.consoleName);
    logger.info({ prefix: detected.prefix, console: detected.consoleName }, "Auto-detected port prefix");
    return detected.prefix;
  }

  logger.error("Could not auto-detect JACK port prefix. Set JACK_PORT_PREFIX explicitly.");
  return config.jackPortPrefix;
}

/**
 * Check if JACK is running and has the expected capture ports.
 * If JACK is not running and auto-start is enabled, will attempt to start it.
 * Auto-detects port prefix if configured to "auto".
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
        const capturePrefix = await resolvePortPrefix();
        const ports = await jackLsp();
        const capturePorts = ports.filter((p) => p.startsWith(capturePrefix));

        if (capturePorts.length < config.channels) {
          logger.warn(
            { found: capturePorts.length, expected: config.channels, prefix: capturePrefix },
            "Found fewer ports than expected"
          );
          logger.info({ ports }, "Available JACK ports");
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
    const capturePrefix = await resolvePortPrefix();
    const ports = await jackLsp();
    const capturePorts = ports.filter((p) => p.startsWith(capturePrefix));

    if (capturePorts.length < config.channels) {
      logger.warn(
        { found: capturePorts.length, expected: config.channels, prefix: capturePrefix },
        "Found fewer ports than expected"
      );
      logger.info({ ports }, "Available JACK ports");
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
  const prefix = config.jackPortPrefix === "auto"
    ? (await detectPortPrefix())?.prefix ?? config.jackPortPrefix
    : config.jackPortPrefix;
  const allPorts = await jackLsp();
  return allPorts.filter((p) => p.startsWith(prefix));
}

/**
 * Setup laptop audio routing to XR18
 * Connects laptop capture ports to XR18 playback ports (e.g., to send laptop audio to XR18 channel 10)
 */
export async function setupLaptopRouting(): Promise<{ ok: boolean; errors: string[] }> {
  const config = getConfig();
  
  if (!config.laptopRouteEnabled) {
    logger.debug("Laptop routing is disabled");
    return { ok: true, errors: [] };
  }

  logger.info({
    leftSrc: config.laptopCaptureLeft,
    rightSrc: config.laptopCaptureRight,
    leftDst: config.xr18PlaybackLeft,
    rightDst: config.xr18PlaybackRight,
  }, "Setting up laptop audio routing to XR18");

  const errors: string[] = [];

  // Connect left channel
  const leftResult = await jackConnect(config.laptopCaptureLeft, config.xr18PlaybackLeft);
  if (!leftResult.ok) {
    const errMsg = `Failed to connect left channel: ${leftResult.error}`;
    logger.error(errMsg);
    errors.push(errMsg);
  } else {
    logger.info({ src: config.laptopCaptureLeft, dst: config.xr18PlaybackLeft }, "Connected left channel");
  }

  // Connect right channel
  const rightResult = await jackConnect(config.laptopCaptureRight, config.xr18PlaybackRight);
  if (!rightResult.ok) {
    const errMsg = `Failed to connect right channel: ${rightResult.error}`;
    logger.error(errMsg);
    errors.push(errMsg);
  } else {
    logger.info({ src: config.laptopCaptureRight, dst: config.xr18PlaybackRight }, "Connected right channel");
  }

  return { ok: errors.length === 0, errors };
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
