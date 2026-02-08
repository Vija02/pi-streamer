# Receiver - Agent Guidelines

## Project Overview

The receiver is an HTTP server that receives 18-channel audio streams from the sender, stores them locally, processes them into individual MP3 files, and optionally uploads to S3. It also serves a web UI for browsing and playing back recordings.

## Tech Stack

- **Runtime**: Bun (required - uses Bun-specific APIs for S3 and SQLite)
- **Database**: SQLite via `bun:sqlite`
- **Web UI**: React + Vite + Tailwind CSS v4
- **Audio Processing**: FFmpeg (must be installed on system)

## Directory Structure

```
receiver/
├── server.ts          # Main HTTP server, routes, request handling
├── db.ts              # SQLite database schema and queries
├── processor.ts       # Audio processing (FLAC -> MP3)
├── session-manager.ts # Session timeout and processing triggers
├── data/              # SQLite database storage
├── received/          # Received audio segments and processed MP3s
│   └── {sessionId}/
│       ├── flac/      # Raw FLAC segments by channel group
│       ├── mp3/       # Processed MP3 files (channel_01.mp3, etc.)
│       └── temp/      # Temporary processing files
└── web/               # React frontend
    ├── src/
    │   ├── App.tsx    # Main app component
    │   └── index.css  # Tailwind imports
    └── dist/          # Built frontend (served by server.ts)
```

## Key Concepts

### Channel Groups

FLAC format only supports up to 8 channels, so the 18 XR18 channels are split into 3 groups:
- `ch01-06` - Channels 1-6
- `ch07-12` - Channels 7-12
- `ch13-18` - Channels 13-18

The sender sends the channel group in the `X-Channel-Group` header.

### Session Lifecycle

1. **receiving** - Actively receiving segments from sender
2. **complete** - All segments received, ready for processing
3. **processing** - FFmpeg extracting channels and encoding MP3s
4. **processed** - All 18 MP3 files created successfully
5. **failed** - Processing encountered an error

### Processing Pipeline

1. Group segments by channel group (ch01-06, ch07-12, ch13-18)
2. For each group, concatenate all segments in order using FFmpeg
3. Extract individual channels from concatenated FLAC
4. Encode each channel to MP3 (320kbps default)
5. Store in `received/{sessionId}/mp3/channel_XX.mp3`

## Running the Server

```bash
# Development
bun run dev

# Production
bun run start

# Build web UI
bun run build:web
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/stream` | Upload audio segment |
| POST | `/session/complete` | Mark session complete |
| POST | `/session/process` | Manually trigger processing |
| GET | `/health` | Health check & queue status |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Get session details |
| GET | `/api/sessions/:id/channels` | Get channel MP3 URLs |
| GET/HEAD | `/api/sessions/:id/channels/:num/audio` | Stream MP3 file |

## Common Issues

### Route Order

The audio endpoint must be defined BEFORE generic session routes in server.ts, otherwise `/api/sessions/:id` matches first and returns 404.

### FFmpeg Concat Paths

The concat file for FFmpeg must use absolute paths (via `resolve()`), not relative paths, because FFmpeg resolves paths relative to the concat file location.

### HEAD Requests

Browsers send HEAD requests when preloading audio. The audio endpoint must handle both GET and HEAD methods.

## Environment Variables

See `.env.example` for all options. Key ones:

- `PORT` - Server port (default: 3000)
- `LOCAL_STORAGE_DIR` - Where to store files (default: ./received)
- `S3_ENABLED` - Enable S3 uploads (default: true)
- `MP3_BITRATE` - MP3 encoding bitrate (default: 320k)

## Testing

```bash
# Test audio endpoint
curl http://localhost:3000/api/sessions/{sessionId}/channels/1/audio -o test.mp3

# Check session status
curl http://localhost:3000/api/sessions | jq

# Trigger processing manually
curl -X POST http://localhost:3000/session/process \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "20260208004253"}'
```
