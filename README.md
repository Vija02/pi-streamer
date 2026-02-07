# XR18 18-Channel Audio Streaming

Stream and record 18 channels from Behringer XR18 via JACK, with local backup, S3 upload, and automatic post-processing to MP3.

## Architecture

**Design Philosophy: Local First, Upload Second, Process Automatically**

Both sender and receiver prioritize local storage first, then upload in the background. When a session completes (gracefully or via timeout), the receiver automatically processes the audio into per-channel MP3 files.

```
┌─────────────┐     JACK      ┌──────────────┐     HTTP POST     ┌──────────────┐
│    XR18     │ ───────────── │    Sender    │ ────────────────> │   Receiver   │
│  (USB/Net)  │               │(jack_capture)│  (per segment)    │  (Bun/SQLite)│
└─────────────┘               └──────────────┘                   └──────────────┘
                                    │                                   │
                                    │ 1. Record WAV                     │ 1. Save locally
                                    │ 2. Compress to FLAC               │ 2. Track in SQLite
                                    │ 3. Upload segments                │ 3. S3 upload (background)
                                    │ 4. Notify completion              │
                                    │                                   │
                                    ▼                                   ▼
                              ./recordings/                    On session complete:
                              {session_id}/                    ┌──────────────────┐
                                                               │ 4. Stitch segments
                                                               │ 5. Extract channels
                                                               │ 6. Encode to MP3
                                                               │ 7. Upload to S3
                                                               └──────────────────┘
                                                                        │
                                                                        ▼
                                                               18 MP3 files per session
                                                               (channel_01.mp3 ... channel_18.mp3)
```

## Features

- **Gapless recording**: Uses `jack_capture` with `--rotatefile` for seamless segment rotation
- **18 channels**: Unlike FFmpeg (limited to 8 JACK channels), `jack_capture` supports unlimited channels
- **FLAC compression**: Records as WAV, then compresses to FLAC channel groups (FLAC only supports 8 channels max, so we split into 3 groups of 6)
- **Automatic processing**: When session completes, receiver automatically creates per-channel MP3 files
- **SQLite tracking**: All sessions, segments, and processed files tracked in database
- **Web UI**: Built-in React frontend for browsing sessions and listening to channels
- **Docker support**: Receiver includes Dockerfile for easy deployment
- **Fault tolerant**: Local recording always works, uploads and processing happen in background with retries
- **Graceful shutdown**: Stop via SIGINT, SIGTERM, or touch a trigger file

## Requirements

### Sender (Linux machine with XR18)

- Bun runtime
- JACK audio server (`jackd2`)
- `jack_capture` (supports unlimited channels)
- `ffmpeg` (for WAV to FLAC compression)

```bash
# Ubuntu/Debian
sudo apt install jackd2 jack-capture ffmpeg

# Arch
sudo pacman -S jack2 jack_capture ffmpeg

# Install Bun
curl -fsSL https://bun.sh/install | bash
```

### Receiver (Cloud/Server)

- Bun runtime (required for SQLite and S3)
- `ffmpeg` (for audio processing)
- AWS S3 bucket (or S3-compatible: Cloudflare R2, MinIO, etc.)

```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# Install Bun
curl -fsSL https://bun.sh/install | bash
```

## Setup

### 1. Connect XR18 via USB

The XR18 should appear as an ALSA device. Check with:

```bash
aplay -l
# Look for: card X: XR18 [XR18], device 0: USB Audio [USB Audio]
```

### 2. Start JACK Server

```bash
# Find the correct device number (replace X)
jackd -d alsa -d hw:XR18 -r 48000 -p 256 -n 3

# Or use QJackCtl for a GUI
qjackctl
```

### 3. Find JACK Port Names

```bash
# List all JACK ports
jack_lsp

# You'll see something like:
# system:capture_1
# system:capture_2
# ... (up to capture_18)
```

### 4. Configure & Run Sender

```bash
cd sender

# Install dependencies
bun install

# Test JACK setup first
bun run src/index.ts test

# Configure (adjust JACK_PORT_PREFIX if needed)
export STREAM_URL="http://your-server:3000/stream"
export JACK_PORT_PREFIX="system:capture_"

# Start recording
bun run start

# Retry any failed uploads
bun run src/index.ts upload-pending
```

### 5. Setup Receiver

```bash
cd receiver

# Install dependencies
bun install

# Build the web UI
cd web && bun install && bun run build && cd ..

# Configure S3 (create .env file)
cat > .env << EOF
S3_ENABLED=true
S3_BUCKET=your-audio-bucket
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
EOF

# Run
bun run server.ts

# Access the web UI at http://localhost:3000
```

### 5b. Setup Receiver with Docker

```bash
cd receiver

# Build the Docker image
docker build -t xr18-receiver .

# Run with environment variables
docker run -d \
  --name xr18-receiver \
  -p 3000:3000 \
  -v xr18-data:/app/data \
  -v xr18-received:/app/received \
  -e S3_ENABLED=true \
  -e S3_BUCKET=your-audio-bucket \
  -e AWS_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID=your-key \
  -e AWS_SECRET_ACCESS_KEY=your-secret \
  xr18-receiver

# Access the web UI at http://localhost:3000
```

## Configuration

### Sender Environment Variables

| Variable                | Default                        | Description                                  |
| ----------------------- | ------------------------------ | -------------------------------------------- |
| `STREAM_URL`            | `http://localhost:3000/stream` | Receiver endpoint                            |
| `RECORDING_DIR`         | `./recordings`                 | Local recording directory                    |
| `SAMPLE_RATE`           | `48000`                        | Audio sample rate                            |
| `CHANNELS`              | `18`                           | Number of channels                           |
| `JACK_PORT_PREFIX`      | `system:capture_`              | JACK port prefix                             |
| `SESSION_ID`            | (timestamp)                    | Unique session ID                            |
| `SEGMENT_DURATION`      | `30`                           | Segment length in seconds                    |
| `UPLOAD_ENABLED`        | `true`                         | Enable server upload                         |
| `UPLOAD_RETRY_COUNT`    | `3`                            | Upload retry attempts                        |
| `UPLOAD_RETRY_DELAY`    | `5000`                         | Delay between retries (ms)                   |
| `COMPRESSION_ENABLED`   | `true`                         | Compress WAV to FLAC before upload           |
| `DELETE_AFTER_COMPRESS` | `true`                         | Delete original WAV after compression        |
| `FINISH_TRIGGER_PATH`   | `/tmp/xr18-finish`             | Touch this file to stop recording gracefully |
| `LOG_LEVEL`             | `info`                         | Logging level: trace, debug, info, warn, error |
| `NODE_ENV`              | -                              | Set to "production" for JSON logging         |

### Receiver Environment Variables

| Variable                   | Default               | Description                                |
| -------------------------- | --------------------- | ------------------------------------------ |
| `PORT`                     | `3000`                | HTTP server port                           |
| `LOCAL_STORAGE_DIR`        | `./received`          | Local storage directory                    |
| `DB_PATH`                  | `./data/receiver.db`  | SQLite database path                       |
| `S3_ENABLED`               | `true`                | Enable S3 uploads                          |
| `S3_BUCKET`                | `your-audio-bucket`   | S3 bucket name                             |
| `S3_PREFIX`                | `recordings/`         | S3 prefix for raw FLAC files               |
| `AWS_REGION`               | `us-east-1`           | AWS region                                 |
| `AWS_ACCESS_KEY_ID`        | -                     | AWS access key                             |
| `AWS_SECRET_ACCESS_KEY`    | -                     | AWS secret key                             |
| `S3_ENDPOINT`              | -                     | Custom S3 endpoint (for R2, MinIO)         |
| `SESSION_TIMEOUT_MINUTES`  | `10`                  | Timeout before auto-processing session     |
| `MP3_BITRATE`              | `320k`                | MP3 encoding bitrate                       |
| `KEEP_FLAC_AFTER_PROCESS`  | `true`                | Keep FLAC files after MP3 created          |
| `UPLOAD_RETRY_INTERVAL`    | `5000`                | Retry delay in ms                          |
| `UPLOAD_MAX_RETRIES`       | `5`                   | Max upload retry attempts                  |
| `UPLOAD_CONCURRENCY`       | `2`                   | Concurrent S3 uploads                      |

## Session Lifecycle

1. **Receiving**: Sender uploads segments, receiver saves and tracks in SQLite
2. **Complete**: Either sender notifies completion, or 10-minute timeout triggers
3. **Processing**: Receiver stitches segments, extracts channels, encodes to MP3
4. **Processed**: 18 MP3 files available, uploaded to S3

### Session Completion

Sessions are marked complete in two ways:

1. **Graceful completion**: When sender stops recording, it sends `POST /session/complete`
2. **Timeout**: If no new segments received for 10 minutes (configurable)

You can also manually trigger processing:

```bash
curl -X POST http://localhost:3000/session/process \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "your-session-id"}'
```

## API Endpoints

### POST /stream

Upload audio segment.

Headers:
- `Content-Type: audio/flac` (or `audio/wav`)
- `X-Session-ID: your-session-id`
- `X-Sample-Rate: 48000`
- `X-Channels: 18`
- `X-Segment-Number: 0`

### POST /session/complete

Mark session as complete and trigger processing.

```json
{ "sessionId": "your-session-id" }
```

### POST /session/process

Manually trigger processing for a session.

```json
{ "sessionId": "your-session-id" }
```

### GET /health

Health check and status.

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "config": {
    "s3Enabled": true,
    "s3Bucket": "my-bucket",
    "localStorageDir": "./received"
  },
  "uploadQueue": {
    "pending": 0,
    "activeUploads": 0,
    "running": false
  },
  "sessionManager": {
    "isRunning": true,
    "isProcessing": false,
    "queueLength": 0,
    "timeoutMinutes": 10
  }
}
```

### GET /api/sessions

List all sessions with stats.

```json
{
  "sessions": [
    {
      "id": "20240115-103000",
      "status": "processed",
      "sample_rate": 48000,
      "channels": 18,
      "created_at": "2024-01-15T10:30:00.000Z",
      "segmentCount": 120,
      "processedChannelCount": 18
    }
  ]
}
```

### GET /api/sessions/:id

Get session details with processed channels.

### GET /api/sessions/:id/channels

Get channel MP3 URLs for a session.

```json
{
  "sessionId": "20240115-103000",
  "status": "processed",
  "channels": [
    {
      "channelNumber": 1,
      "url": "https://bucket.s3.region.amazonaws.com/processed/session/channel_01.mp3",
      "fileSize": 12345678,
      "durationSeconds": 3600.5
    }
  ]
}
```

### POST /retry-failed

Retry any failed S3 uploads.

## File Formats & Sizes

### FLAC Compression (Sender -> Receiver)

Since FLAC only supports up to 8 channels, we split the 18-channel WAV into 3 groups of 6 channels each:

- `segment_XX_ch01-06.flac` - Channels 1-6
- `segment_XX_ch07-12.flac` - Channels 7-12
- `segment_XX_ch13-18.flac` - Channels 13-18

| Scenario                            | WAV Size | Total FLAC Size | Savings |
| ----------------------------------- | -------- | --------------- | ------- |
| All 18 channels active (loud)       | ~74 MB   | ~35-50 MB       | 30-50%  |
| Some channels silent                | ~74 MB   | ~10-30 MB       | 60-85%  |
| Mostly silent (few active channels) | ~74 MB   | ~1-5 MB         | 93-98%  |

### MP3 Output (After Processing)

Each session produces 18 MP3 files:
- `channel_01.mp3` through `channel_18.mp3`
- Encoded at 320kbps (configurable)
- Uploaded to S3 under `processed/{session_id}/`

## Using with Cloudflare R2

R2 is S3-compatible. Set these environment variables:

```bash
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
AWS_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
S3_BUCKET=your-bucket-name
AWS_REGION=auto
```

## Stopping Recording

There are three ways to stop recording gracefully:

1. **SIGINT**: Press `Ctrl+C`
2. **SIGTERM**: Send kill signal (`kill <pid>`)
3. **Trigger file**: Touch the finish trigger file

```bash
# Using trigger file (default path)
touch /tmp/xr18-finish
```

The sender will:
1. Stop `jack_capture` gracefully
2. Wait for the final segment to be written and compressed
3. Upload any remaining segments
4. Notify receiver of session completion
5. Exit cleanly

## Syncing with Video

The recordings include timestamps in the filename. To sync with separately recorded video:

1. **Use timecode**: Start both recordings at a known time (clap, slate)
2. **Match timestamps**: Filename includes ISO timestamp
3. **In your DAW/NLE**: Align using the audio waveform from a reference mic

For frame-accurate sync, consider:

- Recording a guide track to your video camera
- Using LTC timecode on one of the 18 channels
- Starting both recordings via a synchronized trigger

## Troubleshooting

### "JACK server is not running"

Start JACK first:

```bash
jackd -d alsa -d hw:XR18 -r 48000
```

### "Missing dependencies"

Install required packages:

```bash
# Sender
sudo apt install jack-capture jackd2 ffmpeg

# Receiver
sudo apt install ffmpeg
```

### "ffmpeg not found" on receiver

The receiver needs ffmpeg for processing:

```bash
sudo apt install ffmpeg
```

### Session stuck in "receiving" status

Check if the sender sent the completion notification. You can manually trigger processing:

```bash
curl -X POST http://localhost:3000/session/process \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "your-session-id"}'
```

### "S3 upload failed"

1. Check AWS credentials are set
2. Verify bucket exists and you have write access
3. Check S3_ENDPOINT for non-AWS services

## Web UI

The receiver includes a built-in web interface for:

- Viewing all recording sessions
- Monitoring session status (receiving, processing, processed)
- Playing back individual channel MP3s
- Downloading channel audio files

Access it at `http://localhost:3000` after starting the receiver.

### Development

To develop the web UI:

```bash
cd receiver

# Terminal 1: Run the server
bun run dev

# Terminal 2: Run Vite dev server with hot reload
cd web && bun run dev
```

The Vite dev server runs on port 5173 and proxies API requests to the backend on port 3000.

## Project Structure

```
pi-streamer/
├── sender/                 # Runs on device with XR18
│   └── src/
│       ├── index.ts       # Main entry point
│       ├── recorder.ts    # jack_capture recording logic
│       ├── watcher.ts     # File watcher for completed segments
│       ├── compress.ts    # WAV to FLAC compression
│       ├── upload.ts      # Upload queue management
│       ├── jack.ts        # JACK utilities
│       ├── config.ts      # Configuration
│       ├── logger.ts      # Logging (pino)
│       └── utils.ts       # Utility functions
│
├── receiver/               # Runs on server
│   ├── server.ts          # HTTP server + S3 upload queue
│   ├── db.ts              # SQLite database operations
│   ├── processor.ts       # Audio processing (stitch + MP3)
│   ├── session-manager.ts # Session lifecycle + timeout
│   ├── Dockerfile         # Docker build file
│   └── web/               # React frontend (Vite)
│       ├── src/
│       │   └── App.tsx    # Main React component
│       └── dist/          # Built frontend (served by server)
│
└── README.md
```

## Database Schema

The receiver uses SQLite to track sessions and files:

```sql
-- Sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  status TEXT,  -- 'receiving' | 'complete' | 'processing' | 'processed' | 'failed'
  sample_rate INTEGER,
  channels INTEGER,
  created_at TEXT,
  updated_at TEXT,
  completed_at TEXT,
  processed_at TEXT
);

-- Raw FLAC segments
CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  segment_number INTEGER,
  channel_group TEXT,
  local_path TEXT,
  s3_key TEXT,
  file_size INTEGER,
  received_at TEXT
);

-- Processed MP3 files
CREATE TABLE processed_channels (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  channel_number INTEGER,
  local_path TEXT,
  s3_key TEXT,
  s3_url TEXT,
  file_size INTEGER,
  duration_seconds REAL,
  created_at TEXT
);
```
