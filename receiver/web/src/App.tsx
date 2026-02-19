import { useState, useEffect, useRef } from 'react'
import { Route, Switch, useRoute, useLocation, Link } from 'wouter'
import WaveSurfer from 'wavesurfer.js'
import Hls from 'hls.js'
import { Button } from '@/components/ui/button'
import { SimpleDropdown, SimpleDropdownItem } from '@/components/ui/simple-dropdown'

// Types
interface Session {
  id: string
  status: 'receiving' | 'complete' | 'processing' | 'processed' | 'failed'
  sample_rate: number
  channels: number
  created_at: string
  updated_at: string
  completed_at: string | null
  processed_at: string | null
  segmentCount: number
  processedChannelCount: number
  totalSegmentSize: number
  totalProcessedSize: number
  totalDurationSeconds: number | null
  activeChannelCount: number
}

interface Channel {
  channelNumber: number
  url: string | null
  hlsUrl: string | null
  peaksUrl: string | null
  localPath: string
  fileSize: number
  durationSeconds: number | null
  isQuiet: boolean
  isSilent: boolean
}

interface SessionChannelsResponse {
  sessionId: string
  status: string
  channels: Channel[]
}

// API base URL - in dev use proxy, in prod use same origin
const API_BASE = ''

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '-'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatSessionTitle(dateStr: string): string {
  const date = new Date(dateStr)
  
  // Format: Sunday, 8 Feb - 10:30am
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' })
  const day = date.getDate()
  const month = date.toLocaleDateString('en-US', { month: 'short' })
  
  let hours = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const ampm = hours >= 12 ? 'pm' : 'am'
  hours = hours % 12 || 12
  
  return `${dayName}, ${day} ${month} - ${hours}:${minutes}${ampm}`
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr)
  const day = date.getDate().toString().padStart(2, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const year = date.getFullYear()
  return `${day}/${month}/${year}`
}

function formatFullDate(dateStr: string): string {
  const date = new Date(dateStr)
  
  // Format: Sunday, 8 February 2026, 10:30am
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' })
  const day = date.getDate()
  const month = date.toLocaleDateString('en-US', { month: 'long' })
  const year = date.getFullYear()
  
  let hours = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const ampm = hours >= 12 ? 'pm' : 'am'
  hours = hours % 12 || 12
  
  return `${dayName}, ${day} ${month} ${year}, ${hours}:${minutes}${ampm}`
}

const statusColors: Record<Session['status'], string> = {
  receiving: 'bg-blue-500',
  complete: 'bg-amber-500',
  processing: 'bg-violet-500',
  processed: 'bg-emerald-500',
  failed: 'bg-red-500',
}

// Confirmation Modal Component
function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  isLoading = false,
  variant = 'danger',
}: {
  isOpen: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  isLoading?: boolean
  variant?: 'danger' | 'warning'
}) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60" 
        onClick={onCancel}
      />
      
      {/* Modal */}
      <div className="relative bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-slate-400 mb-6">{message}</p>
        
        <div className="flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={isLoading}
          >
            {cancelLabel}
          </Button>
          <Button
            className={variant === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Deleting...
              </>
            ) : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: Session['status'] }) {
  return (
    <span
      className={`${statusColors[status]} text-white px-2 py-0.5 rounded text-xs font-bold uppercase`}
    >
      {status}
    </span>
  )
}

function SessionsList({
  sessions,
  selectedSessionId,
  onRefresh,
  onSelectSession,
  isCollapsed,
  onToggleCollapse,
}: {
  sessions: Session[]
  selectedSessionId: string | null
  onRefresh: () => void
  onSelectSession?: () => void
  isCollapsed?: boolean
  onToggleCollapse?: () => void
}) {
  // Collapsed view - show only minimal session indicators
  if (isCollapsed) {
    return (
      <>
        <div className="p-2 flex flex-col items-center border-b border-slate-700 gap-2">
          <button
            onClick={onToggleCollapse}
            className="bg-transparent border-none text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        {sessions.length === 0 ? (
          <div className="p-2 text-center">
            <span className="text-slate-500 text-xs">-</span>
          </div>
        ) : (
          <ul className="list-none overflow-y-auto flex-1">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/session/${session.id}`}
                  onClick={onSelectSession}
                  className={`flex flex-col items-center justify-center p-2 cursor-pointer border-b border-slate-700 transition-colors hover:bg-slate-700 no-underline ${
                    selectedSessionId === session.id ? 'bg-blue-500' : ''
                  }`}
                  title={formatSessionTitle(session.created_at)}
                >
                  <span className={`w-3 h-3 rounded-full ${statusColors[session.status]}`} />
                  <span className={`text-[10px] mt-1 ${selectedSessionId === session.id ? 'text-white' : 'text-slate-400'}`}>
                    {new Date(session.created_at).getDate()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }

  // Expanded view - full session list
  return (
    <>
      <div className="p-4 flex justify-between items-center border-b border-slate-700">
        <h2 className="text-base font-semibold">Sessions</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="bg-slate-700 text-slate-200 border-none px-3 py-1.5 rounded cursor-pointer text-sm hover:bg-slate-600 transition-colors"
          >
            Refresh
          </button>
          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="bg-transparent border-none text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {sessions.length === 0 ? (
        <p className="text-slate-500 p-4 text-center">No sessions yet</p>
      ) : (
        <ul className="list-none overflow-y-auto flex-1">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link
                href={`/session/${session.id}`}
                onClick={onSelectSession}
                className={`block p-3 cursor-pointer border-b border-slate-700 transition-colors hover:bg-slate-700 no-underline text-inherit ${
                  selectedSessionId === session.id ? 'bg-blue-500' : ''
                }`}
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="font-medium text-sm overflow-hidden text-ellipsis whitespace-nowrap flex-1 mr-2">
                    {formatSessionTitle(session.created_at)}
                  </span>
                  <StatusBadge status={session.status} />
                </div>
                <div
                  className={`flex flex-col gap-0.5 text-xs ${
                    selectedSessionId === session.id ? 'text-blue-200' : 'text-slate-400'
                  }`}
                >
                  <span>
                    {formatShortDate(session.created_at)}
                    {session.totalDurationSeconds !== null && ` | Duration: ${formatDuration(session.totalDurationSeconds)}`}
                  </span>
                  {session.status === 'processed' && (
                    <span>
                      {session.activeChannelCount > 0 
                        ? `${session.activeChannelCount} active channel${session.activeChannelCount !== 1 ? 's' : ''}` 
                        : 'No active channels'}
                      {' | '}{formatBytes(session.totalProcessedSize)}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

// Compact channel strip for the multi-channel mixer
function ChannelStrip({ 
  channel, 
  volume,
  isMuted,
  onVolumeChange,
  onMuteToggle,
  isRegenerating,
  isRegeneratingPeaks,
  onRegenerate,
  onRegeneratePeaks,
  waveformRef,
  isLoaded,
  error,
  onSeek,
  duration,
}: { 
  channel: Channel
  volume: number
  isMuted: boolean
  onVolumeChange: (volume: number) => void
  onMuteToggle: () => void
  isRegenerating?: boolean
  isRegeneratingPeaks?: boolean
  onRegenerate?: () => void
  onRegeneratePeaks?: () => void
  waveformRef: (el: HTMLDivElement | null) => void
  isLoaded: boolean
  error: string | null
  onSeek: (time: number) => void
  duration: number
}) {
  const [isEditingVolume, setIsEditingVolume] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDoubleClick = () => {
    setEditValue(Math.round(volume * 100).toString())
    setIsEditingVolume(true)
  }

  useEffect(() => {
    if (isEditingVolume && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditingVolume])

  const handleVolumeSubmit = () => {
    const parsed = parseFloat(editValue)
    if (!isNaN(parsed) && parsed >= 0) {
      onVolumeChange(parsed / 100)
    }
    setIsEditingVolume(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleVolumeSubmit()
    } else if (e.key === 'Escape') {
      setIsEditingVolume(false)
    }
  }

  return (
    <div className="bg-slate-800 rounded-lg flex items-center gap-2 p-2 relative">
      {/* Channel number */}
      <span className="font-semibold text-sm w-5 text-center shrink-0">{channel.channelNumber}</span>
      
      {/* Quiet indicator */}
      {channel.isQuiet && (
        <span className="bg-slate-600 text-slate-300 px-1 py-0.5 rounded text-[10px] font-medium shrink-0">
          Q
        </span>
      )}

      {/* Audio controls dropdown */}
      <SimpleDropdown
        align="start"
        trigger={
          <button 
            className={`p-1.5 rounded transition-colors shrink-0 ${
              isMuted 
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' 
                : volume > 1
                  ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
            title={isMuted ? 'Muted' : `Volume: ${Math.round(volume * 100)}%`}
          >
            {isMuted ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
            )}
          </button>
        }
      >
        <div className="px-3 py-2 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
          {/* Mute toggle */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-slate-300">Mute</span>
            <button
              onClick={onMuteToggle}
              className={`w-10 h-5 rounded-full transition-colors relative ${
                isMuted ? 'bg-red-500' : 'bg-slate-600'
              }`}
            >
              <span 
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                  isMuted ? 'left-5' : 'left-0.5'
                }`}
              />
            </button>
          </div>
          
          {/* Volume slider */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Volume</span>
              {isEditingVolume ? (
                <input
                  ref={inputRef}
                  type="number"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={handleVolumeSubmit}
                  onKeyDown={handleKeyDown}
                  className="w-16 text-xs text-right bg-slate-900 border border-slate-600 rounded px-1 py-0.5 focus:outline-none focus:border-emerald-500"
                  min="0"
                />
              ) : (
                <span 
                  className={`text-xs cursor-pointer hover:underline ${volume > 1 ? 'text-amber-400' : 'text-slate-400'}`}
                  onDoubleClick={handleDoubleClick}
                  title="Double-click to enter custom value"
                >
                  {Math.round(volume * 100)}%
                </span>
              )}
            </div>
            <input
              type="range"
              min="0"
              max={Math.max(2, volume)}
              step="0.01"
              value={isMuted ? 0 : volume}
              onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
              className={`w-full h-2 rounded-lg appearance-none cursor-pointer ${
                volume > 1 ? 'accent-amber-500' : 'accent-emerald-500'
              }`}
              style={{
                background: `linear-gradient(to right, ${volume > 1 ? '#f59e0b' : '#10b981'} 0%, ${volume > 1 ? '#f59e0b' : '#10b981'} ${(isMuted ? 0 : volume) / Math.max(2, volume) * 100}%, #334155 ${(isMuted ? 0 : volume) / Math.max(2, volume) * 100}%, #334155 100%)`
              }}
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>0%</span>
              <span>100%</span>
              <span>{Math.round(Math.max(2, volume) * 100)}%</span>
            </div>
          </div>
        </div>
      </SimpleDropdown>

      {/* Waveform - clickable to seek */}
      <div 
        className="flex-1 min-w-0 relative"
        onClick={(e) => {
          if (!isLoaded || duration <= 0) return
          const rect = e.currentTarget.getBoundingClientRect()
          const clickX = e.clientX - rect.left
          const percentage = clickX / rect.width
          const newTime = percentage * duration
          onSeek(Math.max(0, Math.min(duration, newTime)))
        }}
      >
        {!isLoaded && (
          <div className="w-full rounded bg-slate-900 h-[40px] flex items-center justify-center">
            {error ? (
              <span className="text-red-400 text-xs">{error}</span>
            ) : (
              <span className="text-slate-500 text-xs">Loading...</span>
            )}
          </div>
        )}
        <div
          ref={waveformRef}
          className={`w-full rounded bg-slate-900 h-[40px] waveform-container cursor-pointer ${!isLoaded ? 'hidden' : ''}`}
          title="Click to seek"
        />
      </div>

      {/* Options menu */}
      <SimpleDropdown
        align="end"
        trigger={
          <button className="p-1.5 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>
        }
      >
        {channel.url && (
          <a href={channel.url} download className="flex items-center gap-2 cursor-pointer relative rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-slate-700">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download MP3
          </a>
        )}
        <SimpleDropdownItem 
          onClick={onRegenerate}
          disabled={isRegenerating}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {isRegenerating ? 'Regenerating...' : 'Regenerate MP3'}
        </SimpleDropdownItem>
        <SimpleDropdownItem 
          onClick={onRegeneratePeaks}
          disabled={isRegeneratingPeaks}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
          {isRegeneratingPeaks ? 'Regenerating...' : 'Regenerate Peaks'}
        </SimpleDropdownItem>
      </SimpleDropdown>

      {/* Regenerating overlay */}
      {(isRegenerating || isRegeneratingPeaks) && (
        <div className="absolute inset-0 bg-slate-900/80 flex items-center justify-center rounded-lg">
          <span className="flex items-center gap-2 text-xs">
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            {isRegeneratingPeaks ? 'Regenerating Peaks...' : 'Regenerating...'}
          </span>
        </div>
      )}
    </div>
  )
}

// Types for time markers/annotations
interface TimeMarker {
  id: string
  time: number // seconds from start
  label: string
  type: 'clock' | 'user' // clock = auto-generated from clock time, user = user-added
  color?: string
}

// API annotation type
interface ApiAnnotation {
  id: number
  timeSeconds: number
  label: string
  color: string | null
  createdAt: string
  updatedAt: string
}

// API channel setting type
interface ApiChannelSetting {
  channelNumber: number
  volume: number
  isMuted: boolean
}

// Generate clock time markers for round times (every 30 minutes)
function generateClockTimeMarkers(sessionStartTime: Date, durationSeconds: number): TimeMarker[] {
  const markers: TimeMarker[] = []
  const startMs = sessionStartTime.getTime()
  
  // Find the first 30-minute mark after (or at) the start
  const startMinutes = sessionStartTime.getMinutes()
  const startSeconds = sessionStartTime.getSeconds()
  
  // Calculate minutes until next 30-min mark (0 or 30)
  let minutesToNext: number
  if (startMinutes < 30) {
    minutesToNext = 30 - startMinutes
  } else {
    minutesToNext = 60 - startMinutes
  }
  // Subtract any seconds we're into the current minute
  const secondsToNext = minutesToNext * 60 - startSeconds
  
  // If we start exactly on a 30-min mark, start from 0
  const firstMarkerOffset = (startMinutes % 30 === 0 && startSeconds === 0) ? 0 : secondsToNext
  
  // Generate markers every 30 minutes
  for (let offsetSeconds = firstMarkerOffset; offsetSeconds < durationSeconds; offsetSeconds += 30 * 60) {
    const markerTime = new Date(startMs + offsetSeconds * 1000)
    let hours = markerTime.getHours()
    const minutes = markerTime.getMinutes()
    const ampm = hours >= 12 ? 'pm' : 'am'
    hours = hours % 12 || 12
    
    const label = `${hours}:${minutes.toString().padStart(2, '0')}${ampm}`
    
    markers.push({
      id: `clock-${offsetSeconds}`,
      time: offsetSeconds,
      label,
      type: 'clock',
      color: '#64748b', // All markers in slate gray
    })
  }
  
  return markers
}

// Timeline component showing time markers - mimics ChannelStrip layout for alignment
function TimelineMarkers({
  markers,
  duration,
  currentTime,
  onSeek,
  onDeleteMarker,
}: {
  markers: TimeMarker[]
  duration: number
  currentTime: number
  onSeek: (time: number) => void
  onDeleteMarker?: (markerId: string) => void
}) {
  if (duration <= 0 || markers.length === 0) return null
  
  return (
    <div className="flex items-center gap-2 px-2 mb-1">
      {/* Spacer for channel number */}
      <span className="w-5 shrink-0" />
      
      {/* Spacer for audio controls button (matches the button width) */}
      <span className="w-[30px] shrink-0" />
      
      {/* Timeline area - matches waveform flex-1 */}
      <div className="flex-1 min-w-0 relative h-6 bg-slate-900/50 rounded">
        {/* Markers */}
        {markers.map((marker) => {
          const position = (marker.time / duration) * 100
          if (position < 0 || position > 100) return null
          
          const isUserMarker = marker.type === 'user'
          
          return (
            <div
              key={marker.id}
              className="absolute top-0 bottom-0 flex flex-col items-center cursor-pointer group"
              style={{ left: `${position}%` }}
              onClick={() => onSeek(marker.time)}
              title={`Jump to ${marker.label}${isUserMarker ? ' (right-click to delete)' : ''}`}
              onContextMenu={(e) => {
                if (isUserMarker && onDeleteMarker) {
                  e.preventDefault()
                  onDeleteMarker(marker.id)
                }
              }}
            >
              {/* Vertical line */}
              <div 
                className={`h-full group-hover:w-1 transition-all ${isUserMarker ? 'w-0.5' : 'w-px'}`}
                style={{ backgroundColor: marker.color || '#64748b' }}
              />
              {/* Label */}
              <span 
                className={`absolute text-[10px] font-medium whitespace-nowrap transform -translate-x-1/2 group-hover:scale-110 transition-transform ${isUserMarker ? 'top-1 bg-slate-800/90 px-1 rounded' : 'top-0.5'}`}
                style={{ color: marker.color || '#64748b' }}
              >
                {marker.label}
              </span>
            </div>
          )
        })}
        
        {/* Current time indicator */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none z-10"
          style={{ left: `${(currentTime / duration) * 100}%` }}
        />
      </div>
      
      {/* Spacer for options menu button */}
      <span className="w-[30px] shrink-0" />
    </div>
  )
}

// Multi-channel player with synchronized playback via Web Audio API
function MultiChannelPlayer({
  channels,
  sessionId,
  sessionCreatedAt,
  regeneratingChannels,
  regeneratingPeaksChannels,
  onRegenerateChannelMp3,
  onRegenerateChannelPeaks,
}: {
  channels: Channel[]
  sessionId: string
  sessionCreatedAt: string
  regeneratingChannels: Set<number>
  regeneratingPeaksChannels: Set<number>
  onRegenerateChannelMp3: (channelNumber: number) => void
  onRegenerateChannelPeaks: (channelNumber: number) => void
}) {
  // Refs for each channel's audio and wavesurfer
  const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map())
  const wavesurferRefs = useRef<Map<number, WaveSurfer>>(new Map())
  const hlsRefs = useRef<Map<number, Hls>>(new Map())
  const waveformContainerRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const loadingChannels = useRef<Set<number>>(new Set())
  
  // Web Audio API for volume boost beyond 100%
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodesRef = useRef<Map<number, GainNode>>(new Map())
  const sourceNodesRef = useRef<Map<number, MediaElementAudioSourceNode>>(new Map())

  // State
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loadedChannels, setLoadedChannels] = useState<Set<number>>(new Set())
  const [channelErrors, setChannelErrors] = useState<Map<number, string>>(new Map())
  const [volumes, setVolumes] = useState<Map<number, number>>(() => {
    const initial = new Map<number, number>()
    channels.forEach(ch => initial.set(ch.channelNumber, 1))
    return initial
  })
  const [mutedChannels, setMutedChannels] = useState<Set<number>>(new Set())
  
  // Refs to track current volume/mute state for use in async callbacks
  const volumesRef = useRef(volumes)
  const mutedChannelsRef = useRef(mutedChannels)
  
  // Keep refs in sync with state
  useEffect(() => {
    volumesRef.current = volumes
    mutedChannelsRef.current = mutedChannels
  }, [volumes, mutedChannels])

  // Annotations state
  const [userAnnotations, setUserAnnotations] = useState<ApiAnnotation[]>([])
  const [isAddingAnnotation, setIsAddingAnnotation] = useState(false)
  const [newAnnotationLabel, setNewAnnotationLabel] = useState('')
  const settingsSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track if we're currently seeking to prevent feedback loops
  const isSeeking = useRef(false)
  const masterTimeRef = useRef(0)

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    }
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // Load a single channel
  const loadChannel = async (channel: Channel, container: HTMLDivElement) => {
    // Prevent double loading using ref (not state) to avoid race conditions
    if (loadingChannels.current.has(channel.channelNumber)) return
    if (wavesurferRefs.current.has(channel.channelNumber)) return
    
    loadingChannels.current.add(channel.channelNumber)
    
    const peaksUrl = `${API_BASE}/api/sessions/${sessionId}/channels/${channel.channelNumber}/peaks`
    const hlsUrl = channel.hlsUrl
    const mp3Url = channel.url || `${API_BASE}/api/sessions/${sessionId}/channels/${channel.channelNumber}/audio`

    try {
      // Fetch peaks
      const peaksResponse = await fetch(peaksUrl)
      if (!peaksResponse.ok) {
        throw new Error('Failed to load waveform')
      }
      const peaksData = await peaksResponse.json()

      // Create audio element
      const audio = document.createElement('audio')
      audio.crossOrigin = 'anonymous'
      audio.preload = 'auto'
      audioRefs.current.set(channel.channelNumber, audio)

      // Setup HLS or MP3
      if (hlsUrl && Hls.isSupported()) {
        const hls = new Hls()
        hls.loadSource(hlsUrl)
        hls.attachMedia(audio)
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            hls.destroy()
            audio.src = mp3Url
          }
        })
        hlsRefs.current.set(channel.channelNumber, hls)
      } else if (hlsUrl && audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = hlsUrl
      } else {
        audio.src = mp3Url
      }

      // Setup Web Audio API for volume boost
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext()
      }
      const audioContext = audioContextRef.current
      
      // Create source node from audio element
      const sourceNode = audioContext.createMediaElementSource(audio)
      sourceNodesRef.current.set(channel.channelNumber, sourceNode)
      
      // Create gain node for volume control (allows > 100%)
      const gainNode = audioContext.createGain()
      // Apply current volume/mute state from refs (may have been loaded from server)
      const currentVolume = volumesRef.current.get(channel.channelNumber) ?? 1
      const isMuted = mutedChannelsRef.current.has(channel.channelNumber)
      gainNode.gain.value = isMuted ? 0 : currentVolume
      gainNodesRef.current.set(channel.channelNumber, gainNode)
      
      // Connect: source -> gain -> destination
      sourceNode.connect(gainNode)
      gainNode.connect(audioContext.destination)

      // Create WaveSurfer - interact disabled, we handle click-to-seek manually
      const ws = WaveSurfer.create({
        container,
        waveColor: '#64748b',
        progressColor: '#10b981',
        cursorColor: '#f8fafc',
        cursorWidth: 1,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        height: 40,
        normalize: true,
        media: audio,
        peaks: [peaksData.data],
        duration: channel.durationSeconds || peaksData.length / peaksData.sample_rate,
        interact: false, // Disabled - we handle click-to-seek manually in ChannelStrip
      })

      ws.on('ready', () => {
        const dur = ws.getDuration()
        setDuration(prev => Math.max(prev, dur))
      })

      wavesurferRefs.current.set(channel.channelNumber, ws)
      setLoadedChannels(prev => new Set(prev).add(channel.channelNumber))
    } catch (err) {
      console.error(`Failed to load channel ${channel.channelNumber}:`, err)
      setChannelErrors(prev => new Map(prev).set(
        channel.channelNumber, 
        err instanceof Error ? err.message : 'Failed to load'
      ))
    } finally {
      loadingChannels.current.delete(channel.channelNumber)
    }
  }

  // Handle waveform container ref callback
  const handleWaveformRef = (channelNumber: number, channel: Channel) => (el: HTMLDivElement | null) => {
    if (el) {
      waveformContainerRefs.current.set(channelNumber, el)
      // Trigger loading when container is available
      loadChannel(channel, el)
    }
  }

  // Load annotations and channel settings on mount
  useEffect(() => {
    const loadAnnotations = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/annotations`)
        if (response.ok) {
          const data = await response.json()
          setUserAnnotations(data.annotations || [])
        }
      } catch (err) {
        console.error('Failed to load annotations:', err)
      }
    }

    const loadChannelSettings = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/channel-settings`)
        if (response.ok) {
          const data = await response.json()
          const settings: ApiChannelSetting[] = data.settings || []
          
          // Apply loaded settings
          const newVolumes = new Map<number, number>()
          const newMuted = new Set<number>()
          
          // Start with defaults
          channels.forEach(ch => newVolumes.set(ch.channelNumber, 1))
          
          // Apply saved settings
          settings.forEach(s => {
            newVolumes.set(s.channelNumber, s.volume)
            if (s.isMuted) newMuted.add(s.channelNumber)
          })
          
          // Update refs immediately (before state update triggers re-render)
          volumesRef.current = newVolumes
          mutedChannelsRef.current = newMuted
          
          // Also apply to any already-loaded gain nodes immediately
          gainNodesRef.current.forEach((gainNode, channelNum) => {
            const volume = newVolumes.get(channelNum) ?? 1
            const isMuted = newMuted.has(channelNum)
            gainNode.gain.setValueAtTime(isMuted ? 0 : volume, gainNode.context.currentTime)
          })
          
          setVolumes(newVolumes)
          setMutedChannels(newMuted)
        }
      } catch (err) {
        console.error('Failed to load channel settings:', err)
      }
    }

    loadAnnotations()
    loadChannelSettings()
  }, [sessionId, channels])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wavesurferRefs.current.forEach(ws => ws.destroy())
      hlsRefs.current.forEach(hls => hls.destroy())
      audioRefs.current.forEach(audio => audio.pause())
      sourceNodesRef.current.forEach(source => source.disconnect())
      gainNodesRef.current.forEach(gain => gain.disconnect())
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
      wavesurferRefs.current.clear()
      hlsRefs.current.clear()
      audioRefs.current.clear()
      sourceNodesRef.current.clear()
      gainNodesRef.current.clear()
      
      // Clear any pending save timeout
      if (settingsSaveTimeoutRef.current) {
        clearTimeout(settingsSaveTimeoutRef.current)
      }
    }
  }, [])

  // Sync time updates from first loaded channel only (master)
  useEffect(() => {
    if (loadedChannels.size === 0) return

    const firstChannel = Array.from(loadedChannels)[0]
    const audio = audioRefs.current.get(firstChannel)
    
    if (!audio) return

    const handleTimeUpdate = () => {
      if (!isSeeking.current) {
        masterTimeRef.current = audio.currentTime
        setCurrentTime(audio.currentTime)
      }
    }

    const handleEnded = () => {
      setIsPlaying(false)
    }

    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [loadedChannels])

  // Apply volume changes via Web Audio API gain nodes
  // Also re-apply when channels finish loading (gain nodes are created then)
  useEffect(() => {
    gainNodesRef.current.forEach((gainNode, channelNum) => {
      const volume = volumes.get(channelNum) ?? 1
      const isMuted = mutedChannels.has(channelNum)
      const newValue = isMuted ? 0 : volume
      gainNode.gain.setValueAtTime(newValue, gainNode.context.currentTime)
    })
  }, [volumes, mutedChannels, loadedChannels])

  // Periodic sync to correct any drift during playback
  useEffect(() => {
    if (!isPlaying || loadedChannels.size < 2) return

    const syncInterval = setInterval(() => {
      const audios = Array.from(audioRefs.current.entries())
      if (audios.length < 2) return

      // Use the first audio as the master reference
      const [, masterAudio] = audios[0]
      const masterTime = masterAudio.currentTime
      const DRIFT_THRESHOLD = 0.05 // 50ms threshold

      // Check and correct drift for other audio elements
      audios.slice(1).forEach(([, audio]) => {
        const drift = Math.abs(audio.currentTime - masterTime)
        if (drift > DRIFT_THRESHOLD) {
          audio.currentTime = masterTime
        }
      })
    }, 500) // Check every 500ms

    return () => clearInterval(syncInterval)
  }, [isPlaying, loadedChannels])

  // Synchronize all audio elements to a target time
  const syncAllToTime = (targetTime: number) => {
    audioRefs.current.forEach((audio) => {
      audio.currentTime = targetTime
    })
  }

  // Play all channels simultaneously
  const playAll = async () => {
    const audios = Array.from(audioRefs.current.values())
    if (audios.length === 0) return

    // Resume AudioContext if suspended (required after user interaction)
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }

    // First, sync all to the same time
    const targetTime = masterTimeRef.current
    syncAllToTime(targetTime)

    // Use Promise.all to start all audio elements as close together as possible
    const playPromises = audios.map(audio => {
      return audio.play().catch(() => {})
    })

    await Promise.all(playPromises)
    setIsPlaying(true)
  }

  // Pause all channels simultaneously  
  const pauseAll = () => {
    audioRefs.current.forEach((audio) => {
      audio.pause()
    })
    setIsPlaying(false)
  }

  // Play/Pause all channels
  const handlePlayPause = () => {
    if (isPlaying) {
      pauseAll()
    } else {
      playAll()
    }
  }

  // Stop all channels
  const handleStop = () => {
    pauseAll()
    syncAllToTime(0)
    masterTimeRef.current = 0
    setCurrentTime(0)
    // Update wavesurfer visuals
    wavesurferRefs.current.forEach(ws => {
      ws.seekTo(0)
    })
  }

  // Seek all channels
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value)
    isSeeking.current = true
    
    // Sync all audio elements to the new time
    syncAllToTime(time)
    
    // Update wavesurfer visuals
    wavesurferRefs.current.forEach(ws => {
      const progress = time / ws.getDuration()
      ws.seekTo(Math.min(1, Math.max(0, progress)))
    })
    
    setCurrentTime(time)
    masterTimeRef.current = time
    
    setTimeout(() => {
      isSeeking.current = false
    }, 100)
  }

  // Skip forward/backward
  const handleSkip = (seconds: number) => {
    const newTime = Math.max(0, Math.min(duration, currentTime + seconds))
    isSeeking.current = true
    
    // Sync all audio elements to the new time
    syncAllToTime(newTime)
    
    // Update wavesurfer visuals
    wavesurferRefs.current.forEach(ws => {
      const progress = newTime / ws.getDuration()
      ws.seekTo(Math.min(1, Math.max(0, progress)))
    })
    
    setCurrentTime(newTime)
    masterTimeRef.current = newTime
    
    setTimeout(() => {
      isSeeking.current = false
    }, 100)
  }

  // Save channel setting to server (debounced)
  const saveChannelSetting = (channelNumber: number, volume: number, isMuted: boolean) => {
    // Debounce saves to avoid too many requests while dragging volume slider
    if (settingsSaveTimeoutRef.current) {
      clearTimeout(settingsSaveTimeoutRef.current)
    }
    settingsSaveTimeoutRef.current = setTimeout(async () => {
      try {
        await fetch(`${API_BASE}/api/sessions/${sessionId}/channel-settings/${channelNumber}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ volume, isMuted }),
        })
      } catch (err) {
        console.error('Failed to save channel setting:', err)
      }
    }, 500)
  }

  // Volume change handler
  const handleVolumeChange = (channelNumber: number, volume: number) => {
    setVolumes(prev => new Map(prev).set(channelNumber, volume))
    // If changing volume while muted, unmute
    const wasMuted = mutedChannels.has(channelNumber)
    if (wasMuted && volume > 0) {
      setMutedChannels(prev => {
        const next = new Set(prev)
        next.delete(channelNumber)
        return next
      })
      saveChannelSetting(channelNumber, volume, false)
    } else {
      saveChannelSetting(channelNumber, volume, wasMuted)
    }
  }

  // Mute toggle handler
  const handleMuteToggle = (channelNumber: number) => {
    const willBeMuted = !mutedChannels.has(channelNumber)
    setMutedChannels(prev => {
      const next = new Set(prev)
      if (next.has(channelNumber)) {
        next.delete(channelNumber)
      } else {
        next.add(channelNumber)
      }
      return next
    })
    const currentVolume = volumes.get(channelNumber) ?? 1
    saveChannelSetting(channelNumber, currentVolume, willBeMuted)
  }

  // Create annotation at current time
  const handleAddAnnotation = async () => {
    if (!newAnnotationLabel.trim()) return
    
    setIsAddingAnnotation(true)
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeSeconds: currentTime,
          label: newAnnotationLabel.trim(),
        }),
      })
      
      if (response.ok) {
        const data = await response.json()
        setUserAnnotations(prev => [...prev, data.annotation].sort((a, b) => a.timeSeconds - b.timeSeconds))
        setNewAnnotationLabel('')
      }
    } catch (err) {
      console.error('Failed to create annotation:', err)
    } finally {
      setIsAddingAnnotation(false)
    }
  }

  // Delete annotation
  const handleDeleteAnnotation = async (annotationId: number) => {
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/annotations/${annotationId}`, {
        method: 'DELETE',
      })
      
      if (response.ok) {
        setUserAnnotations(prev => prev.filter(a => a.id !== annotationId))
      }
    } catch (err) {
      console.error('Failed to delete annotation:', err)
    }
  }

  // Waveform click-to-seek handler
  const handleWaveformSeek = (time: number) => {
    isSeeking.current = true
    
    // Sync all audio elements to the new time
    syncAllToTime(time)
    
    // Update wavesurfer visuals
    wavesurferRefs.current.forEach(ws => {
      const progress = time / ws.getDuration()
      ws.seekTo(Math.min(1, Math.max(0, progress)))
    })
    
    setCurrentTime(time)
    masterTimeRef.current = time
    
    setTimeout(() => {
      isSeeking.current = false
    }, 100)
  }

  const allLoaded = loadedChannels.size === channels.length

  return (
    <div className="flex flex-col gap-4">
      {/* Master Transport Controls */}
      <div className="bg-slate-800 rounded-lg p-4">
        <div className="flex items-center gap-4">
          {/* Play/Stop buttons */}
          <div className="flex items-center gap-2">
            <Button
              onClick={handlePlayPause}
              disabled={!allLoaded}
              className="bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-600"
              size="sm"
            >
              {isPlaying ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </Button>
            <Button
              onClick={handleStop}
              disabled={!allLoaded}
              variant="outline"
              size="sm"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 6h12v12H6z" />
              </svg>
            </Button>
          </div>

          {/* Skip buttons */}
          <div className="flex items-center gap-1">
            <Button
              onClick={() => handleSkip(-10)}
              disabled={!allLoaded}
              variant="ghost"
              size="sm"
              title="Skip back 10s"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z" />
              </svg>
            </Button>
            <Button
              onClick={() => handleSkip(10)}
              disabled={!allLoaded}
              variant="ghost"
              size="sm"
              title="Skip forward 10s"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6l-5.333-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z" />
              </svg>
            </Button>
          </div>

          {/* Time display */}
          <span className="text-sm font-mono text-slate-300 min-w-[80px]">
            {formatTime(currentTime)}
          </span>

          {/* Seek bar */}
          <div className="flex-1">
            <input
              type="range"
              min="0"
              max={duration || 100}
              step="0.1"
              value={currentTime}
              onChange={handleSeek}
              disabled={!allLoaded}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500 disabled:opacity-50"
            />
          </div>

          {/* Duration */}
          <span className="text-sm font-mono text-slate-300 min-w-[80px] text-right">
            {formatTime(duration)}
          </span>

          {/* Loading indicator */}
          {!allLoaded && (
            <span className="text-xs text-slate-400 flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Loading {loadedChannels.size}/{channels.length}
            </span>
          )}
        </div>

        {/* Add annotation controls */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-700">
          <input
            type="text"
            value={newAnnotationLabel}
            onChange={(e) => setNewAnnotationLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddAnnotation()}
            placeholder="Annotation label..."
            className="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-emerald-500"
          />
          <Button
            onClick={handleAddAnnotation}
            disabled={!newAnnotationLabel.trim() || isAddingAnnotation}
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            {isAddingAnnotation ? (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <>
                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Marker at {formatTime(currentTime)}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Timeline with clock time markers and user annotations */}
      {duration > 0 && (() => {
        // Combine clock markers and user annotations
        const clockMarkers = generateClockTimeMarkers(new Date(sessionCreatedAt), duration)
        const userMarkers: TimeMarker[] = userAnnotations.map(a => ({
          id: `user-${a.id}`,
          time: a.timeSeconds,
          label: a.label,
          type: 'user' as const,
          color: a.color || '#10b981', // emerald for user annotations
        }))
        const allMarkers = [...clockMarkers, ...userMarkers].sort((a, b) => a.time - b.time)
        
        return (
          <TimelineMarkers
            markers={allMarkers}
            duration={duration}
            currentTime={currentTime}
            onSeek={handleWaveformSeek}
            onDeleteMarker={(markerId) => {
              // Extract annotation ID from marker ID (format: "user-123")
              const match = markerId.match(/^user-(\d+)$/)
              if (match) {
                handleDeleteAnnotation(parseInt(match[1], 10))
              }
            }}
          />
        )
      })()}

      {/* Channel Strips with overlaid time markers */}
      <div className="relative">
        {/* Vertical marker lines that extend through all channels */}
        {duration > 0 && (() => {
          const clockMarkers = generateClockTimeMarkers(new Date(sessionCreatedAt), duration)
          const userMarkers: TimeMarker[] = userAnnotations.map(a => ({
            id: `user-${a.id}`,
            time: a.timeSeconds,
            label: a.label,
            type: 'user' as const,
            color: a.color || '#10b981',
          }))
          const allMarkers = [...clockMarkers, ...userMarkers]
          
          return (
            <div className="absolute inset-0 pointer-events-none z-10 flex items-stretch gap-2 px-2">
              {/* Spacer for channel number */}
              <span className="w-5 shrink-0" />
              {/* Spacer for audio controls */}
              <span className="w-[30px] shrink-0" />
              {/* Markers container - matches waveform area */}
              <div className="flex-1 min-w-0 relative">
                {allMarkers.map((marker) => {
                  const position = (marker.time / duration) * 100
                  if (position < 0 || position > 100) return null
                  return (
                    <div
                      key={`line-${marker.id}`}
                      className={`absolute top-0 bottom-0 ${marker.type === 'user' ? 'w-0.5 opacity-60' : 'w-px opacity-30'}`}
                      style={{ 
                        left: `${position}%`,
                        backgroundColor: marker.color || '#64748b',
                      }}
                    />
                  )
                })}
              </div>
              {/* Spacer for options menu */}
              <span className="w-[30px] shrink-0" />
            </div>
          )
        })()}

        {/* Channel Strips */}
        <div className="flex flex-col gap-1 relative">
          {channels.map((channel) => (
            <ChannelStrip
              key={channel.channelNumber}
              channel={channel}
              volume={volumes.get(channel.channelNumber) ?? 1}
              isMuted={mutedChannels.has(channel.channelNumber)}
              onVolumeChange={(vol) => handleVolumeChange(channel.channelNumber, vol)}
              onMuteToggle={() => handleMuteToggle(channel.channelNumber)}
              isRegenerating={regeneratingChannels.has(channel.channelNumber)}
              isRegeneratingPeaks={regeneratingPeaksChannels.has(channel.channelNumber)}
              onRegenerate={() => onRegenerateChannelMp3(channel.channelNumber)}
              onRegeneratePeaks={() => onRegenerateChannelPeaks(channel.channelNumber)}
              waveformRef={handleWaveformRef(channel.channelNumber, channel)}
              isLoaded={loadedChannels.has(channel.channelNumber)}
              error={channelErrors.get(channel.channelNumber) || null}
              onSeek={handleWaveformSeek}
              duration={duration}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SessionDetail({
  session,
  channels,
  onTriggerProcess,
  onRegenerateHlsPeaks,
  onRegenerateAllMp3s,
  onRegenerateChannelMp3,
  onRegenerateChannelPeaks,
  onDeleteSession,
  isLoading,
  isRegeneratingHlsPeaks,
  isRegeneratingAllMp3s,
  isDeleting,
  regeneratingChannels,
  regeneratingPeaksChannels,
}: {
  session: Session
  channels: Channel[]
  onTriggerProcess: () => void
  onRegenerateHlsPeaks: () => void
  onRegenerateAllMp3s: () => void
  onRegenerateChannelMp3: (channelNumber: number) => void
  onRegenerateChannelPeaks: (channelNumber: number) => void
  onDeleteSession: () => void
  isLoading: boolean
  isRegeneratingHlsPeaks: boolean
  isRegeneratingAllMp3s: boolean
  isDeleting: boolean
  regeneratingChannels: Set<number>
  regeneratingPeaksChannels: Set<number>
}) {
  const [showSilentChannels, setShowSilentChannels] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  
  // Filter channels - hide silent channels unless showSilentChannels is true
  const visibleChannels = channels.filter(c => showSilentChannels || !c.isSilent)
  const silentChannelCount = channels.filter(c => c.isSilent).length
  
  // Check if any channels are missing HLS or peaks
  const channelsMissingHlsOrPeaks = channels.filter(
    (ch) => !ch.hlsUrl || !ch.peaksUrl
  ).length
  
  const isAnyRegenerating = isRegeneratingHlsPeaks || isRegeneratingAllMp3s || regeneratingChannels.size > 0 || regeneratingPeaksChannels.size > 0
  return (
    <div className="w-full">
      {/* Back button for mobile */}
      <Link
        href="/"
        className="md:hidden inline-flex items-center gap-2 text-slate-400 hover:text-slate-200 mb-4 no-underline"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to sessions
      </Link>

      <div className="flex flex-wrap items-center gap-4 mb-6">
        <h2 className="text-xl sm:text-2xl font-semibold break-all">{formatSessionTitle(session.created_at)}</h2>
        <StatusBadge status={session.status} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4 bg-slate-800 p-4 rounded-lg mb-6">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 uppercase">Created</label>
          <span className="text-sm font-medium">{formatFullDate(session.created_at)}</span>
        </div>
        {session.totalDurationSeconds !== null && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 uppercase">Duration</label>
            <span className="text-sm font-medium">{formatDuration(session.totalDurationSeconds)}</span>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 uppercase">Sample Rate</label>
          <span className="text-sm font-medium">{session.sample_rate} Hz</span>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 uppercase">Channels</label>
          <span className="text-sm font-medium">{session.channels}</span>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 uppercase">Segments</label>
          <span className="text-sm font-medium">{session.segmentCount}</span>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 uppercase">Raw Size</label>
          <span className="text-sm font-medium">{formatBytes(session.totalSegmentSize)}</span>
        </div>
        {session.processedChannelCount > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 uppercase">Processed Size</label>
            <span className="text-sm font-medium">{formatBytes(session.totalProcessedSize)}</span>
          </div>
        )}
      </div>

      {(session.status === 'receiving' || session.status === 'complete' || session.status === 'failed') && (
        <div className="mb-6">
          <button
            onClick={onTriggerProcess}
            disabled={isLoading}
            className="bg-blue-500 text-white border-none px-5 py-2.5 rounded-md text-sm font-medium cursor-pointer hover:bg-blue-600 transition-colors disabled:bg-slate-500 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Processing...' : 'Process Now'}
          </button>
        </div>
      )}

      {session.status === 'processing' && (
        <div className="bg-violet-600 text-white px-4 py-3 rounded-md mb-6">
          Processing audio... This may take a few minutes.
        </div>
      )}

      {session.status === 'processed' && channels.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
            <h3 className="text-lg font-semibold">Audio Channels</h3>
            <SimpleDropdown
              align="end"
              disabled={isAnyRegenerating}
              trigger={
                <Button variant="outline" disabled={isAnyRegenerating}>
                  {isAnyRegenerating ? (
                    <>
                      <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Processing...
                    </>
                  ) : (
                    <>
                      Actions
                      <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </>
                  )}
                </Button>
              }
            >
              <SimpleDropdownItem 
                onClick={onRegenerateAllMp3s}
                disabled={isRegeneratingAllMp3s}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Regenerate All MP3s
              </SimpleDropdownItem>
              {channelsMissingHlsOrPeaks > 0 && (
                <SimpleDropdownItem 
                  onClick={onRegenerateHlsPeaks}
                  disabled={isRegeneratingHlsPeaks}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                  Generate HLS/Peaks ({channelsMissingHlsOrPeaks})
                </SimpleDropdownItem>
              )}
              <div className="my-1 h-px bg-slate-600" />
              <SimpleDropdownItem 
                onClick={() => setShowDeleteConfirm(true)}
                className="text-red-400 hover:text-red-300"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete Session
              </SimpleDropdownItem>
            </SimpleDropdown>
          </div>
          <MultiChannelPlayer
            channels={visibleChannels}
            sessionId={session.id}
            sessionCreatedAt={session.created_at}
            regeneratingChannels={regeneratingChannels}
            regeneratingPeaksChannels={regeneratingPeaksChannels}
            onRegenerateChannelMp3={onRegenerateChannelMp3}
            onRegenerateChannelPeaks={onRegenerateChannelPeaks}
          />
          
          {/* Toggle for silent channels */}
          {silentChannelCount > 0 && (
            <button
              onClick={() => setShowSilentChannels(!showSilentChannels)}
              className="mt-4 text-sm text-slate-400 hover:text-slate-200 flex items-center gap-2"
            >
              <svg 
                className={`w-4 h-4 transition-transform ${showSilentChannels ? 'rotate-90' : ''}`} 
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {showSilentChannels ? 'Hide' : 'Show'} {silentChannelCount} silent channel{silentChannelCount !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}

      {session.status === 'processed' && channels.length === 0 && (
        <div className="text-slate-500 p-4 text-center">No processed channels found</div>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        title="Delete Session"
        message={`Are you sure you want to delete this session? This will permanently remove all files from local storage and S3. This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {
          onDeleteSession()
          setShowDeleteConfirm(false)
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        isLoading={isDeleting}
        variant="danger"
      />
    </div>
  )
}

function SessionPage({
  sessions,
  fetchSessions,
}: {
  sessions: Session[]
  fetchSessions: () => void
}) {
  const [, params] = useRoute('/session/:id')
  const sessionId = params?.id || null
  const [channels, setChannels] = useState<Channel[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isRegeneratingHlsPeaks, setIsRegeneratingHlsPeaks] = useState(false)
  const [isRegeneratingAllMp3s, setIsRegeneratingAllMp3s] = useState(false)
  const [regeneratingChannels, setRegeneratingChannels] = useState<Set<number>>(new Set())
  const [regeneratingPeaksChannels, setRegeneratingPeaksChannels] = useState<Set<number>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)
  const [, setLocation] = useLocation()

  const session = sessions.find((s) => s.id === sessionId)

  // Fetch channels for selected session
  const fetchChannels = async (id: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${id}/channels`)
      const data: SessionChannelsResponse = await response.json()
      setChannels(data.channels || [])
    } catch (err) {
      console.error('Failed to fetch channels:', err)
      setChannels([])
    }
  }

  // Trigger processing
  const triggerProcess = async () => {
    if (!sessionId) return

    setIsLoading(true)
    try {
      await fetch(`${API_BASE}/session/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      // Refresh after triggering
      setTimeout(() => {
        fetchSessions()
        setIsLoading(false)
      }, 1000)
    } catch (err) {
      console.error('Failed to trigger processing:', err)
      setIsLoading(false)
    }
  }

  // Regenerate HLS and peaks
  const regenerateHlsAndPeaks = async () => {
    if (!sessionId) return

    setIsRegeneratingHlsPeaks(true)
    try {
      const response = await fetch(`${API_BASE}/session/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const result = await response.json()
      
      if (result.success) {
        // Refresh channels to get new URLs
        await fetchChannels(sessionId)
      } else {
        console.error('Regeneration failed:', result.errors)
        alert(`Regeneration failed: ${result.errors?.join(', ') || 'Unknown error'}`)
      }
    } catch (err) {
      console.error('Failed to regenerate:', err)
      alert('Failed to regenerate HLS/Peaks')
    } finally {
      setIsRegeneratingHlsPeaks(false)
    }
  }

  // Regenerate all MP3s
  const regenerateAllMp3s = async () => {
    if (!sessionId) return

    setIsRegeneratingAllMp3s(true)
    // Mark all channels as regenerating
    setRegeneratingChannels(new Set(channels.map(c => c.channelNumber)))
    
    try {
      const response = await fetch(`${API_BASE}/session/regenerate-mp3`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const result = await response.json()
      
      if (result.success) {
        // Refresh channels to get new data
        await fetchChannels(sessionId)
      } else {
        const failures = result.results?.filter((r: { success: boolean }) => !r.success) || []
        if (failures.length > 0) {
          console.error('Some channels failed:', failures)
          alert(`${failures.length} channel(s) failed to regenerate`)
        }
      }
    } catch (err) {
      console.error('Failed to regenerate MP3s:', err)
      alert('Failed to regenerate MP3s')
    } finally {
      setIsRegeneratingAllMp3s(false)
      setRegeneratingChannels(new Set())
    }
  }

  // Regenerate single channel MP3
  const regenerateChannelMp3 = async (channelNumber: number) => {
    if (!sessionId) return

    setRegeneratingChannels(prev => new Set(prev).add(channelNumber))
    
    try {
      const response = await fetch(`${API_BASE}/session/regenerate-mp3-channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, channelNumber }),
      })
      const result = await response.json()
      
      if (result.success) {
        // Refresh channels to get new data
        await fetchChannels(sessionId)
      } else {
        console.error('Channel regeneration failed:', result.error)
        alert(`Failed to regenerate channel ${channelNumber}: ${result.error || 'Unknown error'}`)
      }
    } catch (err) {
      console.error('Failed to regenerate channel:', err)
      alert(`Failed to regenerate channel ${channelNumber}`)
    } finally {
      setRegeneratingChannels(prev => {
        const next = new Set(prev)
        next.delete(channelNumber)
        return next
      })
    }
  }

  // Regenerate single channel peaks
  const regenerateChannelPeaks = async (channelNumber: number) => {
    if (!sessionId) return

    setRegeneratingPeaksChannels(prev => new Set(prev).add(channelNumber))
    
    try {
      const response = await fetch(`${API_BASE}/session/regenerate-peaks-channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, channelNumber }),
      })
      const result = await response.json()
      
      if (result.success) {
        // Refresh channels to get new data
        await fetchChannels(sessionId)
      } else {
        console.error('Channel peaks regeneration failed:', result.error)
        alert(`Failed to regenerate peaks for channel ${channelNumber}: ${result.error || 'Unknown error'}`)
      }
    } catch (err) {
      console.error('Failed to regenerate channel peaks:', err)
      alert(`Failed to regenerate peaks for channel ${channelNumber}`)
    } finally {
      setRegeneratingPeaksChannels(prev => {
        const next = new Set(prev)
        next.delete(channelNumber)
        return next
      })
    }
  }

  // Delete session
  const deleteSession = async () => {
    if (!sessionId) return

    setIsDeleting(true)
    try {
      const response = await fetch(`${API_BASE}/session/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const result = await response.json()
      
      if (result.success) {
        // Refresh sessions and navigate to home
        fetchSessions()
        setLocation('/')
      } else {
        console.error('Delete failed:', result.error)
        alert(`Failed to delete session: ${result.error || 'Unknown error'}`)
      }
    } catch (err) {
      console.error('Failed to delete session:', err)
      alert('Failed to delete session')
    } finally {
      setIsDeleting(false)
    }
  }

  useEffect(() => {
    if (sessionId) {
      fetchChannels(sessionId)
    } else {
      setChannels([])
    }
  }, [sessionId])

  // Redirect to home if session not found (after sessions are loaded)
  useEffect(() => {
    if (sessions.length > 0 && sessionId && !session) {
      setLocation('/')
    }
  }, [sessions, sessionId, session, setLocation])

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-base">
        <p>Session not found</p>
      </div>
    )
  }

  return (
    <SessionDetail
      session={session}
      channels={channels}
      onTriggerProcess={triggerProcess}
      onRegenerateHlsPeaks={regenerateHlsAndPeaks}
      onRegenerateAllMp3s={regenerateAllMp3s}
      onRegenerateChannelMp3={regenerateChannelMp3}
      onRegenerateChannelPeaks={regenerateChannelPeaks}
      onDeleteSession={deleteSession}
      isLoading={isLoading}
      isRegeneratingHlsPeaks={isRegeneratingHlsPeaks}
      isRegeneratingAllMp3s={isRegeneratingAllMp3s}
      isDeleting={isDeleting}
      regeneratingChannels={regeneratingChannels}
      regeneratingPeaksChannels={regeneratingPeaksChannels}
    />
  )
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [, params] = useRoute('/session/:id')
  const selectedSessionId = params?.id || null

  // Fetch sessions
  const fetchSessions = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/sessions`)
      const data = await response.json()
      setSessions(data.sessions || [])
    } catch (err) {
      setError('Failed to fetch sessions')
      console.error(err)
    }
  }

  // Initial fetch
  useEffect(() => {
    fetchSessions()
    // Poll for updates every 10 seconds
    const interval = setInterval(fetchSessions, 10000)
    return () => clearInterval(interval)
  }, [])

  // Close mobile sidebar and collapse desktop sidebar when route changes
  useEffect(() => {
    setSidebarOpen(false)
    if (selectedSessionId) {
      setSidebarCollapsed(true)
    }
  }, [selectedSessionId])

  const toggleSidebarCollapse = () => {
    setSidebarCollapsed(prev => !prev)
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-slate-800 px-4 sm:px-6 py-4 border-b border-slate-700 flex items-center gap-4">
        {/* Mobile menu button */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="md:hidden bg-transparent border-none text-slate-200 p-1 cursor-pointer"
          aria-label="Toggle menu"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 className="text-lg sm:text-xl font-semibold text-slate-50">Hope Newcastle Recordings</h1>
      </header>

      {error && (
        <div className="bg-red-600 text-white px-6 py-3 text-center">{error}</div>
      )}

      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-10 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - collapsible on desktop, slide-in on mobile */}
        <div
          className={`
            fixed md:static inset-y-0 left-0 z-20
            ${sidebarCollapsed ? 'w-14' : 'w-80'} 
            bg-slate-800 border-r border-slate-700 flex flex-col overflow-hidden
            transform transition-all duration-200 ease-in-out
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
            top-[57px] md:top-0 h-[calc(100vh-57px)] md:h-auto
          `}
        >
          <SessionsList
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onRefresh={fetchSessions}
            onSelectSession={() => setSidebarOpen(false)}
            isCollapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebarCollapse}
          />
        </div>

        {/* Main content - full width */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Switch>
            <Route path="/session/:id">
              <SessionPage sessions={sessions} fetchSessions={fetchSessions} />
            </Route>
            <Route path="/">
              <div className="flex items-center justify-center h-full text-slate-500 text-base">
                <p>Select a session to view details</p>
              </div>
            </Route>
          </Switch>
        </div>
      </div>
    </div>
  )
}

export default App
