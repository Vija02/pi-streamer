/**
 * JACK Audio utilities
 */
import { $ } from "bun";
import { getConfig } from "./config";
import { jackLogger as logger } from "./logger";

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
}

/**
 * Check if JACK is running and has the expected capture ports
 */
export async function checkJackSetup(): Promise<JackCheckResult> {
  const config = getConfig();

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
 * Connect JACK ports for the configured channels
 */
export async function connectJackPorts(): Promise<void> {
  const config = getConfig();

  logger.info("Connecting JACK ports...");

  // First, list all available ports to find FFmpeg's input ports
  const allPorts = await jackLsp();
  const ffmpegPorts = allPorts.filter((p) => p.startsWith(config.jackClientName + ":"));
  
  if (ffmpegPorts.length === 0) {
    logger.error({ clientName: config.jackClientName, allPorts }, "No FFmpeg JACK ports found");
    return;
  }
  
  logger.info({ ffmpegPorts }, "Found FFmpeg JACK ports");

  for (let i = 1; i <= config.channels; i++) {
    const srcPort = `${config.jackPortPrefix}${i}`;
    // FFmpeg JACK ports are typically named "clientname:input_N" where N is 1-indexed
    const dstPort = ffmpegPorts[i - 1] || `${config.jackClientName}:input_${i}`;

    const result = await jackConnect(srcPort, dstPort);
    if (result.ok) {
      logger.debug({ src: srcPort, dst: dstPort }, "Connected port");
    } else {
      logger.warn({ src: srcPort, dst: dstPort, error: result.error }, "Could not connect port");
    }
  }

  logger.info({ channels: config.channels }, "JACK ports connection complete");
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
