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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

const statusColors: Record<Session['status'], string> = {
  receiving: 'bg-blue-500',
  complete: 'bg-amber-500',
  processing: 'bg-violet-500',
  processed: 'bg-emerald-500',
  failed: 'bg-red-500',
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
}: {
  sessions: Session[]
  selectedSessionId: string | null
  onRefresh: () => void
  onSelectSession?: () => void
}) {
  return (
    <>
      <div className="p-4 flex justify-between items-center border-b border-slate-700">
        <h2 className="text-base font-semibold">Sessions</h2>
        <button
          onClick={onRefresh}
          className="bg-slate-700 text-slate-200 border-none px-3 py-1.5 rounded cursor-pointer text-sm hover:bg-slate-600 transition-colors"
        >
          Refresh
        </button>
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
                <div className="flex justify-between items-center mb-2">
                  <span className="font-medium text-sm overflow-hidden text-ellipsis whitespace-nowrap max-w-[180px]">
                    {session.id}
                  </span>
                  <StatusBadge status={session.status} />
                </div>
                <div
                  className={`flex flex-wrap gap-x-3 gap-y-1 text-xs ${
                    selectedSessionId === session.id ? 'text-blue-200' : 'text-slate-400'
                  }`}
                >
                  <span>{formatDate(session.created_at)}</span>
                  <span>{session.segmentCount} segments</span>
                  {session.status === 'processed' && (
                    <span>{session.processedChannelCount} channels</span>
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

function AudioPlayer({ 
  channel, 
  sessionId,
  isRegenerating,
  onRegenerate,
}: { 
  channel: Channel
  sessionId: string
  isRegenerating?: boolean
  onRegenerate?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const wavesurferRef = useRef<WaveSurfer | null>(null)
  const hlsRef = useRef<Hls | null>(null)

  const [isLoaded, setIsLoaded] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(channel.durationSeconds || 0)
  const [error, setError] = useState<string | null>(null)

  // URLs
  const peaksUrl = channel.peaksUrl || `${API_BASE}/api/sessions/${sessionId}/channels/${channel.channelNumber}/peaks`
  const hlsUrl = channel.hlsUrl
  const mp3Url = channel.url || `${API_BASE}/api/sessions/${sessionId}/channels/${channel.channelNumber}/audio`

  const loadPlayer = async () => {
    if (!containerRef.current || isLoaded) return
    setError(null)

    try {
      // 1. Fetch peaks
      const peaksResponse = await fetch(peaksUrl)
      if (!peaksResponse.ok) {
        throw new Error('Failed to load waveform data')
      }
      const peaksData = await peaksResponse.json()

      // 2. Create audio element
      const audio = document.createElement('audio')
      audio.crossOrigin = 'anonymous'
      audioRef.current = audio

      // 3. Setup HLS or fallback to MP3
      if (hlsUrl && Hls.isSupported()) {
        const hls = new Hls()
        hls.loadSource(hlsUrl)
        hls.attachMedia(audio)
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            console.error('HLS error, falling back to MP3:', data)
            hls.destroy()
            audio.src = mp3Url
          }
        })
        hlsRef.current = hls
      } else if (hlsUrl && audio.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS
        audio.src = hlsUrl
      } else {
        // Fallback to MP3
        audio.src = mp3Url
      }

      // 4. Create WaveSurfer with pre-computed peaks
      const ws = WaveSurfer.create({
        container: containerRef.current,
        waveColor: '#64748b',
        progressColor: '#10b981',
        cursorColor: '#f8fafc',
        cursorWidth: 2,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        height: 60,
        normalize: true,
        media: audio,
        peaks: [peaksData.data],
        duration: channel.durationSeconds || peaksData.length / peaksData.sample_rate,
      })

      ws.on('ready', () => {
        setDuration(ws.getDuration())
      })
      ws.on('play', () => setIsPlaying(true))
      ws.on('pause', () => setIsPlaying(false))
      ws.on('finish', () => setIsPlaying(false))
      ws.on('timeupdate', (time) => setCurrentTime(time))

      wavesurferRef.current = ws
      setIsLoaded(true)
    } catch (err) {
      console.error('Failed to load player:', err)
      setError(err instanceof Error ? err.message : 'Failed to load audio player')
    }
  }

  // Load player automatically on mount
  useEffect(() => {
    loadPlayer()
  }, [])

  // Cleanup
  useEffect(() => {
    return () => {
      wavesurferRef.current?.destroy()
      hlsRef.current?.destroy()
      audioRef.current?.pause()
    }
  }, [])

  const handlePlayPause = () => {
    wavesurferRef.current?.playPause()
  }

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    }
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div className="bg-slate-800 p-4 rounded-lg flex flex-col gap-3 relative">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        <span className="font-semibold text-base min-w-[100px]">Channel {channel.channelNumber}</span>
        {channel.isQuiet && (
          <span className="bg-slate-600 text-slate-300 px-2 py-0.5 rounded text-xs font-medium">
            Quiet
          </span>
        )}
        <span className="text-sm text-slate-400">{formatDuration(channel.durationSeconds)}</span>
        <span className="text-sm text-slate-400">{formatBytes(channel.fileSize)}</span>
      </div>

      {/* Waveform container */}
      {!isLoaded && (
        <div className="w-full rounded bg-slate-900 h-[60px] flex items-center justify-center">
          {error ? (
            <span className="text-red-400 text-sm">{error}</span>
          ) : (
            <span className="text-slate-400 text-sm flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Loading waveform...
            </span>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        className={`w-full rounded bg-slate-900 min-h-[60px] ${!isLoaded ? 'hidden' : ''}`}
      />

      {/* Time display */}
      {isLoaded && (
        <div className="flex justify-between text-xs text-slate-400">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-2 items-center flex-wrap">
        {isLoaded && (
          <Button
            onClick={handlePlayPause}
            className="bg-emerald-500 hover:bg-emerald-600"
          >
            {isPlaying ? 'Pause' : 'Play'}
          </Button>
        )}
        
        <SimpleDropdown
          trigger={
            <Button variant="outline" size="sm">
              Options
              <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Button>
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
            {isRegenerating ? (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            {isRegenerating ? 'Regenerating...' : 'Regenerate MP3'}
          </SimpleDropdownItem>
        </SimpleDropdown>
      </div>

      {/* Regenerating overlay */}
      {isRegenerating && (
        <div className="absolute inset-0 bg-slate-900/80 flex items-center justify-center rounded-lg">
          <span className="flex items-center gap-2 text-sm">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Regenerating...
          </span>
        </div>
      )}
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
  isLoading,
  isRegeneratingHlsPeaks,
  isRegeneratingAllMp3s,
  regeneratingChannels,
}: {
  session: Session
  channels: Channel[]
  onTriggerProcess: () => void
  onRegenerateHlsPeaks: () => void
  onRegenerateAllMp3s: () => void
  onRegenerateChannelMp3: (channelNumber: number) => void
  isLoading: boolean
  isRegeneratingHlsPeaks: boolean
  isRegeneratingAllMp3s: boolean
  regeneratingChannels: Set<number>
}) {
  // Check if any channels are missing HLS or peaks
  const channelsMissingHlsOrPeaks = channels.filter(
    (ch) => !ch.hlsUrl || !ch.peaksUrl
  ).length
  
  const isAnyRegenerating = isRegeneratingHlsPeaks || isRegeneratingAllMp3s || regeneratingChannels.size > 0
  return (
    <div className="max-w-4xl">
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
        <h2 className="text-xl sm:text-2xl font-semibold break-all">{session.id}</h2>
        <StatusBadge status={session.status} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4 bg-slate-800 p-4 rounded-lg mb-6">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 uppercase">Created</label>
          <span className="text-sm font-medium">{formatDate(session.created_at)}</span>
        </div>
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
            </SimpleDropdown>
          </div>
          <div className="flex flex-col gap-3">
            {channels.map((channel) => (
              <AudioPlayer 
                key={channel.channelNumber} 
                channel={channel} 
                sessionId={session.id}
                isRegenerating={regeneratingChannels.has(channel.channelNumber)}
                onRegenerate={() => onRegenerateChannelMp3(channel.channelNumber)}
              />
            ))}
          </div>
        </div>
      )}

      {session.status === 'processed' && channels.length === 0 && (
        <div className="text-slate-500 p-4 text-center">No processed channels found</div>
      )}
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
      isLoading={isLoading}
      isRegeneratingHlsPeaks={isRegeneratingHlsPeaks}
      isRegeneratingAllMp3s={isRegeneratingAllMp3s}
      regeneratingChannels={regeneratingChannels}
    />
  )
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
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

  // Close sidebar when route changes
  useEffect(() => {
    setSidebarOpen(false)
  }, [selectedSessionId])

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
        <h1 className="text-lg sm:text-xl font-semibold text-slate-50">XR18 Audio Sessions</h1>
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

        {/* Sidebar */}
        <div
          className={`
            fixed md:static inset-y-0 left-0 z-20
            w-80 bg-slate-800 border-r border-slate-700 flex flex-col overflow-hidden
            transform transition-transform duration-200 ease-in-out
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
            top-[57px] md:top-0 h-[calc(100vh-57px)] md:h-auto
          `}
        >
          <SessionsList
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onRefresh={fetchSessions}
            onSelectSession={() => setSidebarOpen(false)}
          />
        </div>

        {/* Main content */}
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
