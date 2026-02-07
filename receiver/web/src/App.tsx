import { useState, useEffect } from 'react'
import './App.css'

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

function StatusBadge({ status }: { status: Session['status'] }) {
  const colors: Record<Session['status'], string> = {
    receiving: '#3b82f6',
    complete: '#f59e0b',
    processing: '#8b5cf6',
    processed: '#10b981',
    failed: '#ef4444',
  }
  return (
    <span
      style={{
        backgroundColor: colors[status],
        color: 'white',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 'bold',
        textTransform: 'uppercase',
      }}
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
    <div className="sessions-list">
      <div className="sessions-header">
        <h2>Sessions</h2>
        <button onClick={onRefresh} className="refresh-btn">
          Refresh
        </button>
      </div>
      {sessions.length === 0 ? (
        <p className="empty-message">No sessions yet</p>
      ) : (
        <ul>
          {sessions.map((session) => (
            <li
              key={session.id}
              className={`session-item ${selectedSessionId === session.id ? 'selected' : ''}`}
              onClick={() => onSelectSession(session.id)}
            >
              <div className="session-item-header">
                <span className="session-id">{session.id}</span>
                <StatusBadge status={session.status} />
              </div>
              <div className="session-item-meta">
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
    <div className="channel-item">
      <div className="channel-info">
        <span className="channel-number">Channel {channel.channelNumber}</span>
        <span className="channel-duration">{formatDuration(channel.durationSeconds)}</span>
        <span className="channel-size">{formatBytes(channel.fileSize)}</span>
      </div>
      <div className="channel-controls">
        <button onClick={togglePlay} className="play-btn">
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        {channel.url && (
          <a href={channel.url} download className="download-btn">
            Download
          </a>
        )}
      </div>
      {audioElement && (
        <audio
          src={audioUrl}
          controls
          className="audio-element"
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
    <div className="session-detail">
      <div className="session-detail-header">
        <h2>{session.id}</h2>
        <StatusBadge status={session.status} />
      </div>

      <div className="session-meta">
        <div className="meta-item">
          <label>Created</label>
          <span>{formatDate(session.created_at)}</span>
        </div>
        <div className="meta-item">
          <label>Sample Rate</label>
          <span>{session.sample_rate} Hz</span>
        </div>
        <div className="meta-item">
          <label>Channels</label>
          <span>{session.channels}</span>
        </div>
        <div className="meta-item">
          <label>Segments</label>
          <span>{session.segmentCount}</span>
        </div>
        <div className="meta-item">
          <label>Raw Size</label>
          <span>{formatBytes(session.totalSegmentSize)}</span>
        </div>
        {session.processedChannelCount > 0 && (
          <div className="meta-item">
            <label>Processed Size</label>
            <span>{formatBytes(session.totalProcessedSize)}</span>
          </div>
        )}
      </div>

      {(session.status === 'receiving' || session.status === 'complete' || session.status === 'failed') && (
        <div className="session-actions">
          <button
            onClick={onTriggerProcess}
            disabled={isLoading}
            className="process-btn"
          >
            {isLoading ? 'Processing...' : 'Process Now'}
          </button>
        </div>
      )}

      {session.status === 'processing' && (
        <div className="processing-message">
          Processing audio... This may take a few minutes.
        </div>
      )}

      {session.status === 'processed' && channels.length > 0 && (
        <div className="channels-section">
          <h3>Audio Channels</h3>
          <div className="channels-list">
            {channels.map((channel) => (
              <AudioPlayer key={channel.channelNumber} channel={channel} sessionId={session.id} />
            ))}
          </div>
        </div>
      )}

      {session.status === 'processed' && channels.length === 0 && (
        <div className="empty-message">No processed channels found</div>
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
    <div className="app">
      <header className="app-header">
        <h1>XR18 Audio Sessions</h1>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="app-content">
        <SessionsList
          sessions={sessions}
          onSelectSession={setSelectedSessionId}
          selectedSessionId={selectedSessionId}
          onRefresh={fetchSessions}
        />

        <div className="main-panel">
          {selectedSession ? (
            <SessionDetail
              session={selectedSession}
              channels={channels}
              onTriggerProcess={triggerProcess}
              isLoading={isLoading}
            />
          ) : (
            <div className="empty-state">
              <p>Select a session to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
