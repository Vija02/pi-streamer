/**
 * Scheduler module for time-based recording
 * 
 * Watches a schedule file and automatically starts/stops recordings
 * based on configured time slots.
 * 
 * Schedule file format (schedule.json):
 * {
 *   "slots": [
 *     { "start": "2024-02-07T09:00:00", "end": "2024-02-07T10:30:00" },
 *     { "start": "2024-02-07T14:00:00", "end": "2024-02-07T16:00:00" }
 *   ]
 * }
 */

import { watch, type FSWatcher } from "fs";
import { schedulerLogger as logger } from "./logger";
import { startRecordingSession, stopRecordingSession, isRecording, getRecorderState } from "./recorder";
import { formatTimestamp } from "./utils";

export interface TimeSlot {
  start: string;  // ISO 8601 datetime
  end: string;    // ISO 8601 datetime
  name?: string;  // Optional name for the session
}

export interface Schedule {
  slots: TimeSlot[];
}

interface SchedulerState {
  isRunning: boolean;
  schedule: Schedule | null;
  schedulePath: string | null;
  fileWatcher: FSWatcher | null;
  currentSlot: TimeSlot | null;
  checkInterval: ReturnType<typeof setInterval> | null;
}

const state: SchedulerState = {
  isRunning: false,
  schedule: null,
  schedulePath: null,
  fileWatcher: null,
  currentSlot: null,
  checkInterval: null,
};

/**
 * Load schedule from file
 */
async function loadSchedule(filePath: string): Promise<Schedule | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      logger.warn({ filePath }, "Schedule file not found");
      return null;
    }

    const content = await file.json();
    
    // Validate schedule format
    if (!content.slots || !Array.isArray(content.slots)) {
      logger.error({ filePath }, "Invalid schedule format: missing 'slots' array");
      return null;
    }

    // Validate each slot
    for (const slot of content.slots) {
      if (!slot.start || !slot.end) {
        logger.error({ slot }, "Invalid slot: missing start or end time");
        return null;
      }
      
      const startDate = new Date(slot.start);
      const endDate = new Date(slot.end);
      
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        logger.error({ slot }, "Invalid slot: invalid date format");
        return null;
      }
      
      if (endDate <= startDate) {
        logger.error({ slot }, "Invalid slot: end time must be after start time");
        return null;
      }
    }

    // Sort slots by start time
    content.slots.sort((a: TimeSlot, b: TimeSlot) => 
      new Date(a.start).getTime() - new Date(b.start).getTime()
    );

    logger.info({ slotCount: content.slots.length, filePath }, "Schedule loaded");
    return content as Schedule;
  } catch (err) {
    logger.error({ err, filePath }, "Failed to load schedule file");
    return null;
  }
}

/**
 * Find the current active slot (if any)
 */
function findActiveSlot(schedule: Schedule): TimeSlot | null {
  const now = Date.now();
  
  for (const slot of schedule.slots) {
    const startTime = new Date(slot.start).getTime();
    const endTime = new Date(slot.end).getTime();
    
    if (now >= startTime && now < endTime) {
      return slot;
    }
  }
  
  return null;
}

/**
 * Find the next upcoming slot
 */
function findNextSlot(schedule: Schedule): { slot: TimeSlot; msUntilStart: number } | null {
  const now = Date.now();
  
  for (const slot of schedule.slots) {
    const startTime = new Date(slot.start).getTime();
    
    if (startTime > now) {
      return { slot, msUntilStart: startTime - now };
    }
  }
  
  return null;
}

/**
 * Generate a session ID for a slot
 */
function generateSessionId(slot: TimeSlot): string {
  if (slot.name) {
    // Sanitize name for use in path
    const sanitized = slot.name.replace(/[^a-zA-Z0-9-_]/g, "_");
    return `${formatTimestamp(new Date(slot.start))}_${sanitized}`;
  }
  return formatTimestamp(new Date(slot.start));
}

/**
 * Check schedule and start/stop recordings as needed
 */
async function checkSchedule(): Promise<void> {
  if (!state.schedule) return;

  const now = new Date();
  const activeSlot = findActiveSlot(state.schedule);
  const recording = isRecording();

  // Case 1: Should be recording but not currently recording
  if (activeSlot && !recording) {
    const sessionId = generateSessionId(activeSlot);
    logger.info({ 
      slot: activeSlot, 
      sessionId,
      currentTime: now.toISOString() 
    }, "Starting scheduled recording");
    
    state.currentSlot = activeSlot;
    await startRecordingSession(sessionId);
  }
  
  // Case 2: Currently recording but slot has ended
  if (recording && state.currentSlot) {
    const endTime = new Date(state.currentSlot.end).getTime();
    
    if (now.getTime() >= endTime) {
      logger.info({ 
        slot: state.currentSlot,
        currentTime: now.toISOString() 
      }, "Stopping scheduled recording (slot ended)");
      
      await stopRecordingSession();
      state.currentSlot = null;
    }
  }

  // Log next slot info periodically (every minute when not recording)
  if (!recording && !activeSlot) {
    const next = findNextSlot(state.schedule);
    if (next && next.msUntilStart < 120000) { // Log if next slot is within 2 minutes
      const minutes = Math.ceil(next.msUntilStart / 60000);
      logger.info({ 
        nextSlot: next.slot, 
        minutesUntilStart: minutes 
      }, "Next recording slot coming up");
    }
  }
}

/**
 * Handle schedule file changes (hot-reload)
 */
async function onScheduleFileChange(): Promise<void> {
  if (!state.schedulePath) return;
  
  logger.info("Schedule file changed, reloading...");
  
  const newSchedule = await loadSchedule(state.schedulePath);
  if (newSchedule) {
    state.schedule = newSchedule;
    
    // Log the updated schedule
    for (const slot of newSchedule.slots) {
      const startDate = new Date(slot.start);
      const endDate = new Date(slot.end);
      const now = new Date();
      
      let status = "upcoming";
      if (endDate < now) status = "past";
      else if (startDate <= now && endDate > now) status = "active";
      
      logger.info({ 
        start: slot.start, 
        end: slot.end, 
        name: slot.name,
        status 
      }, "Schedule slot");
    }
    
    // Check immediately after reload
    await checkSchedule();
  }
}

/**
 * Start the scheduler
 */
export async function startScheduler(schedulePath: string): Promise<void> {
  if (state.isRunning) {
    logger.warn("Scheduler is already running");
    return;
  }

  logger.info({ schedulePath }, "Starting scheduler");
  
  state.schedulePath = schedulePath;
  state.isRunning = true;

  // Load initial schedule
  state.schedule = await loadSchedule(schedulePath);
  
  if (state.schedule) {
    logger.info({ slotCount: state.schedule.slots.length }, "Scheduler initialized with schedule");
    
    // Log all slots
    for (const slot of state.schedule.slots) {
      const startDate = new Date(slot.start);
      const endDate = new Date(slot.end);
      const durationMinutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);
      
      logger.info({ 
        start: slot.start, 
        end: slot.end, 
        durationMinutes,
        name: slot.name 
      }, "Scheduled slot");
    }
  } else {
    logger.warn("No valid schedule loaded. Waiting for schedule file...");
  }

  // Watch for file changes
  try {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    
    state.fileWatcher = watch(schedulePath, (eventType) => {
      if (eventType === "change") {
        // Debounce file changes (editors may trigger multiple events)
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          onScheduleFileChange();
        }, 500);
      }
    });
    
    logger.info("Watching schedule file for changes");
  } catch (err) {
    logger.warn({ err }, "Could not watch schedule file (will not auto-reload)");
  }

  // Start checking schedule every second
  state.checkInterval = setInterval(() => {
    checkSchedule().catch((err) => {
      logger.error({ err }, "Error checking schedule");
    });
  }, 1000);

  // Do initial check
  await checkSchedule();

  logger.info("Scheduler is running. Waiting for scheduled time slots...");
}

/**
 * Stop the scheduler
 */
export async function stopScheduler(): Promise<void> {
  if (!state.isRunning) return;

  logger.info("Stopping scheduler");
  
  state.isRunning = false;

  // Stop file watcher
  if (state.fileWatcher) {
    state.fileWatcher.close();
    state.fileWatcher = null;
  }

  // Stop check interval
  if (state.checkInterval) {
    clearInterval(state.checkInterval);
    state.checkInterval = null;
  }

  // Stop any active recording
  if (isRecording()) {
    logger.info("Stopping active recording");
    await stopRecordingSession();
  }

  state.schedule = null;
  state.schedulePath = null;
  state.currentSlot = null;

  logger.info("Scheduler stopped");
}

/**
 * Get current scheduler state (for status/debugging)
 */
export function getSchedulerState(): {
  isRunning: boolean;
  hasSchedule: boolean;
  slotCount: number;
  currentSlot: TimeSlot | null;
  nextSlot: { slot: TimeSlot; msUntilStart: number } | null;
  isRecording: boolean;
} {
  return {
    isRunning: state.isRunning,
    hasSchedule: state.schedule !== null,
    slotCount: state.schedule?.slots.length ?? 0,
    currentSlot: state.currentSlot,
    nextSlot: state.schedule ? findNextSlot(state.schedule) : null,
    isRecording: isRecording(),
  };
}
