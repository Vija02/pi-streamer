/**
 * Audio compression module
 *
 * Compresses 18-channel WAV files into multiple FLAC files (channel groups).
 * FLAC only supports up to 8 channels, so we split into groups:
 * - channels 1-6   -> segment_XX_ch01-06.flac
 * - channels 7-12  -> segment_XX_ch07-12.flac
 * - channels 13-18 -> segment_XX_ch13-18.flac
 *
 * Uses ffmpeg for the conversion.
 */
import { $ } from "bun"
import { join, dirname, basename } from "path"
import { compressLogger as logger } from "./logger"
import { getConfig } from "./config"

export interface CompressedFiles {
	originalWav: string
	flacFiles: string[]
	segmentNumber: number
}

/**
 * Channel group definition
 */
interface ChannelGroup {
	name: string      // e.g., "ch01-06"
	startChannel: number  // 0-indexed for ffmpeg
	endChannel: number    // 0-indexed for ffmpeg (exclusive)
}

/**
 * Get channel groups based on total channel count
 * Split into groups of 6 channels each (well under FLAC's 8-channel limit)
 */
function getChannelGroups(totalChannels: number): ChannelGroup[] {
	const groups: ChannelGroup[] = []
	const groupSize = 6

	for (let start = 0; start < totalChannels; start += groupSize) {
		const end = Math.min(start + groupSize, totalChannels)
		const startDisplay = start + 1  // 1-indexed for display
		const endDisplay = end          // 1-indexed for display
		groups.push({
			name: `ch${String(startDisplay).padStart(2, "0")}-${String(endDisplay).padStart(2, "0")}`,
			startChannel: start,
			endChannel: end,
		})
	}

	return groups
}

/**
 * Build ffmpeg filter for extracting specific channels
 * Uses channelsplit and amerge to extract and recombine channels
 */
function buildChannelFilter(startChannel: number, endChannel: number, totalChannels: number): string {
	const numChannels = endChannel - startChannel

	// Use pan filter to extract specific channels
	// pan=6c|c0=c0|c1=c1|c2=c2|c3=c3|c4=c4|c5=c5
	const channelMappings: string[] = []
	for (let i = 0; i < numChannels; i++) {
		channelMappings.push(`c${i}=c${startChannel + i}`)
	}

	return `pan=${numChannels}c|${channelMappings.join("|")}`
}

/**
 * Compress a single WAV file into multiple FLAC files (one per channel group)
 */
export async function compressWavToFlac(wavPath: string, segmentNumber: number): Promise<CompressedFiles> {
	const config = getConfig()
	const dir = dirname(wavPath)
	const segmentStr = String(segmentNumber).padStart(2, "0")

	const channelGroups = getChannelGroups(config.channels)
	const flacFiles: string[] = []

	logger.info({ wavPath, segmentNumber, groups: channelGroups.length }, "Compressing WAV to FLAC")

	for (const group of channelGroups) {
		const flacFilename = `segment_${segmentStr}_${group.name}.flac`
		const flacPath = join(dir, flacFilename)

		const filter = buildChannelFilter(group.startChannel, group.endChannel, config.channels)
		const numChannels = group.endChannel - group.startChannel

		try {
			// Use ffmpeg to extract channels and compress to FLAC
			const result = await $`ffmpeg -y -i ${wavPath} -af ${filter} -c:a flac -compression_level 8 ${flacPath}`.quiet()

			if (result.exitCode !== 0) {
				const stderr = result.stderr.toString()
				logger.error({ group: group.name, stderr }, "ffmpeg compression failed")
				throw new Error(`ffmpeg failed for ${group.name}: ${stderr}`)
			}

			flacFiles.push(flacPath)
			logger.debug({ flacPath, channels: `${group.startChannel + 1}-${group.endChannel}` }, "Created FLAC file")
		} catch (err) {
			logger.error({ err, group: group.name }, "Failed to compress channel group")
			throw err
		}
	}

	logger.info(
		{ segmentNumber, flacCount: flacFiles.length },
		"Compression complete"
	)

	return {
		originalWav: wavPath,
		flacFiles,
		segmentNumber,
	}
}

/**
 * Delete the original WAV file after successful compression
 */
export async function deleteOriginalWav(wavPath: string): Promise<void> {
	try {
		await $`rm ${wavPath}`.quiet()
		logger.debug({ wavPath }, "Deleted original WAV file")
	} catch (err) {
		logger.warn({ err, wavPath }, "Failed to delete original WAV file")
	}
}

/**
 * Check if ffmpeg is available
 */
export async function checkFfmpeg(): Promise<boolean> {
	try {
		const result = await $`which ffmpeg`.quiet()
		return result.exitCode === 0
	} catch {
		return false
	}
}
