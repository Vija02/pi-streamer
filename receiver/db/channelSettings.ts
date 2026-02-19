/**
 * Channel Settings Database Operations
 *
 * Manages per-session channel volume and mute settings.
 */
import { getDatabase } from "./connection";
import type { ChannelSetting } from "./types";

/**
 * Get or create channel setting for a specific channel
 */
export function getOrCreateChannelSetting(
  sessionId: string,
  channelNumber: number
): ChannelSetting {
  const existing = getChannelSetting(sessionId, channelNumber);
  if (existing) return existing;

  const db = getDatabase();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO channel_settings 
     (session_id, channel_number, volume, is_muted, created_at, updated_at)
     VALUES (?, ?, 1.0, 0, ?, ?)`,
    [sessionId, channelNumber, now, now]
  );

  return getChannelSetting(sessionId, channelNumber)!;
}

/**
 * Get channel setting for a specific channel
 */
export function getChannelSetting(
  sessionId: string,
  channelNumber: number
): ChannelSetting | null {
  const db = getDatabase();
  return db
    .query<ChannelSetting, [string, number]>(
      "SELECT * FROM channel_settings WHERE session_id = ? AND channel_number = ?"
    )
    .get(sessionId, channelNumber);
}

/**
 * Get all channel settings for a session
 */
export function getChannelSettingsBySession(
  sessionId: string
): ChannelSetting[] {
  const db = getDatabase();
  return db
    .query<ChannelSetting, [string]>(
      "SELECT * FROM channel_settings WHERE session_id = ? ORDER BY channel_number ASC"
    )
    .all(sessionId);
}

/**
 * Update channel setting (volume and/or mute)
 */
export function updateChannelSetting(
  sessionId: string,
  channelNumber: number,
  updates: {
    volume?: number;
    isMuted?: boolean;
  }
): ChannelSetting {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Ensure the setting exists
  getOrCreateChannelSetting(sessionId, channelNumber);

  const fields: string[] = ["updated_at = ?"];
  const values: (string | number)[] = [now];

  if (updates.volume !== undefined) {
    fields.push("volume = ?");
    values.push(updates.volume);
  }
  if (updates.isMuted !== undefined) {
    fields.push("is_muted = ?");
    values.push(updates.isMuted ? 1 : 0);
  }

  values.push(sessionId, channelNumber);

  db.run(
    `UPDATE channel_settings SET ${fields.join(", ")} WHERE session_id = ? AND channel_number = ?`,
    values
  );

  return getChannelSetting(sessionId, channelNumber)!;
}

/**
 * Bulk update channel settings for a session
 */
export function bulkUpdateChannelSettings(
  sessionId: string,
  settings: Array<{
    channelNumber: number;
    volume?: number;
    isMuted?: boolean;
  }>
): ChannelSetting[] {
  for (const setting of settings) {
    updateChannelSetting(sessionId, setting.channelNumber, {
      volume: setting.volume,
      isMuted: setting.isMuted,
    });
  }
  return getChannelSettingsBySession(sessionId);
}

/**
 * Delete all channel settings for a session
 */
export function deleteChannelSettingsBySession(sessionId: string): number {
  const db = getDatabase();
  const result = db.run("DELETE FROM channel_settings WHERE session_id = ?", [
    sessionId,
  ]);
  return result.changes;
}

/**
 * Convert channel settings to a map for easy lookup
 */
export function getChannelSettingsMap(
  sessionId: string
): Map<number, { volume: number; isMuted: boolean }> {
  const settings = getChannelSettingsBySession(sessionId);
  const map = new Map<number, { volume: number; isMuted: boolean }>();

  for (const setting of settings) {
    map.set(setting.channel_number, {
      volume: setting.volume,
      isMuted: setting.is_muted === 1,
    });
  }

  return map;
}
