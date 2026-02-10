/**
 * Channel Group Utilities
 *
 * FLAC format supports max 8 channels, so 18 XR18 channels are split into 3 groups:
 * - ch01-06: Channels 1-6
 * - ch07-12: Channels 7-12
 * - ch13-18: Channels 13-18
 */

/**
 * Standard channel groups for 18-channel XR18
 */
export const CHANNEL_GROUPS = ["ch01-06", "ch07-12", "ch13-18"] as const;
export type ChannelGroup = (typeof CHANNEL_GROUPS)[number];

/**
 * Parse channel group string to get the channels it contains
 * e.g., "ch01-06" -> [1, 2, 3, 4, 5, 6]
 */
export function parseChannelGroup(channelGroup: string): number[] {
  const match = channelGroup.match(/ch(\d+)-(\d+)/);
  if (!match) return [];

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);

  const channels: number[] = [];
  for (let i = start; i <= end; i++) {
    channels.push(i);
  }
  return channels;
}

/**
 * Get the index of a channel within its channel group (0-indexed)
 * e.g., channel 7 in "ch07-12" -> 0
 * e.g., channel 9 in "ch07-12" -> 2
 */
export function getChannelIndexInGroup(channelNumber: number, channelGroup: string): number {
  const channels = parseChannelGroup(channelGroup);
  return channels.indexOf(channelNumber);
}

/**
 * Find which channel group contains a specific channel
 */
export function findChannelGroup(
  channelNumber: number,
  availableGroups: string[] = [...CHANNEL_GROUPS]
): string | null {
  for (const group of availableGroups) {
    const channels = parseChannelGroup(group);
    if (channels.includes(channelNumber)) {
      return group;
    }
  }
  return null;
}

/**
 * Extract channel group from a filename
 * e.g., "segment_00_ch01-06.flac" -> "ch01-06"
 */
export function extractChannelGroupFromFilename(filename: string): string | undefined {
  const match = filename.match(/(ch\d+-\d+)/);
  return match ? match[1] : undefined;
}

/**
 * Extract segment number from a filename
 * e.g., "segment_00_ch01-06.flac" -> 0
 * e.g., "20260208_seg00005_ch01-06.flac" -> 5
 */
export function extractSegmentNumberFromFilename(filename: string): number | undefined {
  // Try segment_XX format first
  let match = filename.match(/segment_(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }

  // Try _segXXXXX format
  match = filename.match(/_seg(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }

  return undefined;
}

/**
 * Get the channel group for a given channel number
 */
export function getChannelGroupForChannel(channelNumber: number): ChannelGroup | null {
  if (channelNumber >= 1 && channelNumber <= 6) return "ch01-06";
  if (channelNumber >= 7 && channelNumber <= 12) return "ch07-12";
  if (channelNumber >= 13 && channelNumber <= 18) return "ch13-18";
  return null;
}

/**
 * Get all channel numbers (1-18)
 */
export function getAllChannelNumbers(): number[] {
  return Array.from({ length: 18 }, (_, i) => i + 1);
}

/**
 * Validate a channel number is within the expected range
 */
export function isValidChannelNumber(channelNumber: number, maxChannels: number = 18): boolean {
  return Number.isInteger(channelNumber) && channelNumber >= 1 && channelNumber <= maxChannels;
}
