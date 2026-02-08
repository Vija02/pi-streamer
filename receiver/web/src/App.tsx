import { useState, useEffect } from 'react'

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
  localPath: string
  fileSize: number
  durationSeconds: number | null
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
  onSelectSession,
  selectedSessionId,
  onRefresh,
}: {
  sessions: Session[]
  onSelectSession: (id: string) => void
  selectedSessionId: string | null
  onRefresh: () => void
}) {
  return (
    <div className="w-80 bg-slate-800 border-r border-slate-700 flex flex-col overflow-hidden">
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
            <li
              key={session.id}
              className={`p-3 cursor-pointer border-b border-slate-700 transition-colors hover:bg-slate-700 ${
                selectedSessionId === session.id ? 'bg-blue-500' : ''
              }`}
              onClick={() => onSelectSession(session.id)}
            >
              <div className="flex justify-between items-center mb-2">
                <span className="font-medium text-sm overflow-hidden text-ellipsis whitespace-nowrap max-w-[180px]">
                  {session.id}
                </span>
                <StatusBadge status={session.status} />
              </div>
              <div
                className={`flex gap-3 text-xs ${
                  selectedSessionId === session.id ? 'text-blue-200' : 'text-slate-400'
                }`}
              >
                <span>{formatDate(session.created_at)}</span>
                <span>{session.segmentCount} segments</span>
                {session.status === 'processed' && (
                  <span>{session.processedChannelCount} channels</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AudioPlayer({ channel, sessionId }: { channel: Channel; sessionId: string }) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)

  // Construct audio URL - use S3 URL if available, otherwise local path via API
  const audioUrl = channel.url || `${API_BASE}/api/sessions/${sessionId}/channels/${channel.channelNumber}/audio`

  useEffect(() => {
    return () => {
      if (audioElement) {
        audioElement.pause()
      }
    }
  }, [audioElement])

  const togglePlay = () => {
    if (!audioElement) {
      const audio = new Audio(audioUrl)
      audio.onended = () => setIsPlaying(false)
      audio.onerror = () => {
        console.error('Audio error')
        setIsPlaying(false)
      }
      setAudioElement(audio)
      audio.play()
      setIsPlaying(true)
    } else if (isPlaying) {
      audioElement.pause()
      setIsPlaying(false)
    } else {
      audioElement.play()
      setIsPlaying(true)
    }
  }

  return (
    <div className="bg-slate-800 p-4 rounded-lg flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <span className="font-semibold text-base min-w-[100px]">Channel {channel.channelNumber}</span>
        <span className="text-sm text-slate-400">{formatDuration(channel.durationSeconds)}</span>
        <span className="text-sm text-slate-400">{formatBytes(channel.fileSize)}</span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={togglePlay}
          className="bg-emerald-500 text-white px-4 py-2 rounded border-none text-sm font-medium cursor-pointer hover:bg-emerald-600 transition-colors"
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        {channel.url && (
          <a
            href={channel.url}
            download
            className="bg-slate-700 text-slate-200 px-4 py-2 rounded text-sm font-medium no-underline inline-block text-center hover:bg-slate-600 transition-colors"
          >
            Download
          </a>
        )}
      </div>
      {audioElement && (
        <audio
          src={audioUrl}
          controls
          className="w-full mt-2 h-10"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
        />
      )}
    </div>
  )
}

function SessionDetail({
  session,
  channels,
  onTriggerProcess,
  isLoading,
}: {
  session: Session
  channels: Channel[]
  onTriggerProcess: () => void
  isLoading: boolean
}) {
  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-4 mb-6">
        <h2 className="text-2xl font-semibold">{session.id}</h2>
        <StatusBadge status={session.status} />
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4 bg-slate-800 p-4 rounded-lg mb-6">
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
          <h3 className="text-lg font-semibold mb-4">Audio Channels</h3>
          <div className="flex flex-col gap-3">
            {channels.map((channel) => (
              <AudioPlayer key={channel.channelNumber} channel={channel} sessionId={session.id} />
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

function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  // Fetch channels for selected session
  const fetchChannels = async (sessionId: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/channels`)
      const data: SessionChannelsResponse = await response.json()
      setChannels(data.channels || [])
    } catch (err) {
      console.error('Failed to fetch channels:', err)
      setChannels([])
    }
  }

  // Trigger processing
  const triggerProcess = async () => {
    if (!selectedSessionId) return

    setIsLoading(true)
    try {
      await fetch(`${API_BASE}/session/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: selectedSessionId }),
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

  // Initial fetch
  useEffect(() => {
    fetchSessions()
    // Poll for updates every 10 seconds
    const interval = setInterval(fetchSessions, 10000)
    return () => clearInterval(interval)
  }, [])

  // Fetch channels when session changes
  useEffect(() => {
    if (selectedSessionId) {
      fetchChannels(selectedSessionId)
    } else {
      setChannels([])
    }
  }, [selectedSessionId])

  const selectedSession = sessions.find((s) => s.id === selectedSessionId)

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-slate-800 px-6 py-4 border-b border-slate-700">
        <h1 className="text-xl font-semibold text-slate-50">XR18 Audio Sessions</h1>
      </header>

      {error && (
        <div className="bg-red-600 text-white px-6 py-3 text-center">{error}</div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <SessionsList
          sessions={sessions}
          onSelectSession={setSelectedSessionId}
          selectedSessionId={selectedSessionId}
          onRefresh={fetchSessions}
        />

        <div className="flex-1 overflow-y-auto p-6">
          {selectedSession ? (
            <SessionDetail
              session={selectedSession}
              channels={channels}
              onTriggerProcess={triggerProcess}
              isLoading={isLoading}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500 text-base">
              <p>Select a session to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
