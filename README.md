# XR18 18-Channel Audio Streaming

Stream and record 18 channels from Behringer XR18 via JACK, with local backup and S3 upload.

## Architecture

**Design Philosophy: Local First, Upload Second**

Both sender and receiver prioritize local storage first, then upload in the background. This ensures:

- No data loss if network fails
- Fast response times (local writes are quick)
- Automatic retry of failed uploads
- If recorder shuts off unexpectedly, you only lose the current segment (max 30 seconds by default)

```
┌─────────────┐     JACK      ┌──────────────┐     HTTP POST     ┌──────────────┐
│    XR18     │ ───────────── │    Sender    │ ────────────────> │   Receiver   │
│  (USB/Net)  │               │(jack_capture)│  (per segment)    │  (Bun/Node)  │
└─────────────┘               └──────────────┘                   └──────────────┘
                                    │                                   │
                                    │ 1. Record                         │ 1. Save
                                    │    WAV                            │    locally
                                    │                                   │
                                    │ 2. Compress                       │ 2. Queue for
                                    │    to FLAC                        │    S3 upload
                                    │    (3 files)                      │
                                    │                                   │
                                    │ 3. Upload                         │
                                    │    segments                       │
                                    ▼                                   ▼
                              ./recordings/                       ./received/
                              {session_id}/                       {session_id}/
                                    │                                   │
                                    │                                   │ Background
                                    │                                   │ upload queue
                                    │                                   ▼
                                    │                                  S3
                                    │                           (or R2, MinIO)
                                    │
                                    └──────── Both have local copies ───┘
```

## Features

- **Gapless recording**: Uses `jack_capture` with `--rotatefile` for seamless segment rotation
- **18 channels**: Unlike FFmpeg (limited to 8 JACK channels), `jack_capture` supports unlimited channels
- **FLAC compression**: Records as WAV, then compresses to FLAC channel groups (FLAC only supports 8 channels max, so we split into 3 groups of 6)
- **Fault tolerant**: Local recording always works, uploads happen in background with retries
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

- Bun (recommended) or Node.js 22+
- AWS S3 bucket (or S3-compatible: Cloudflare R2, MinIO, etc.)

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
# or: npm install

# Configure S3
cp .env.example .env
# Edit .env with your S3 credentials

# Run
bun run start
# or: npm run start:node
```

## Configuration

### Sender Environment Variables

| Variable              | Default                        | Description                                  |
| --------------------- | ------------------------------ | -------------------------------------------- |
| `STREAM_URL`          | `http://localhost:3000/stream` | Receiver endpoint                            |
| `RECORDING_DIR`       | `./recordings`                 | Local recording directory                    |
| `SAMPLE_RATE`         | `48000`                        | Audio sample rate                            |
| `CHANNELS`            | `18`                           | Number of channels                           |
| `JACK_PORT_PREFIX`    | `system:capture_`              | JACK port prefix                             |
| `SESSION_ID`          | (timestamp)                    | Unique session ID                            |
| `SEGMENT_DURATION`    | `30`                           | Segment length in seconds                    |
| `UPLOAD_ENABLED`        | `true`                         | Enable server upload                         |
| `UPLOAD_RETRY_COUNT`    | `3`                            | Upload retry attempts                        |
| `UPLOAD_RETRY_DELAY`    | `5000`                         | Delay between retries (ms)                   |
| `COMPRESSION_ENABLED`   | `true`                         | Compress WAV to FLAC before upload           |
| `DELETE_AFTER_COMPRESS` | `true`                         | Delete original WAV after compression        |
| `FINISH_TRIGGER_PATH`   | `/tmp/xr18-finish`             | Touch this file to stop recording gracefully |
| `LOG_LEVEL`           | `info`                         | Logging level: trace, debug, info, warn, error |
| `NODE_ENV`            | -                              | Set to "production" for JSON logging         |

### Receiver Environment Variables

| Variable                | Default             | Description                        |
| ----------------------- | ------------------- | ---------------------------------- |
| `PORT`                  | `3000`              | HTTP server port                   |
| `LOCAL_STORAGE_DIR`     | `./received`        | Local storage directory (primary)  |
| `S3_ENABLED`            | `true`              | Enable S3 uploads                  |
| `S3_BUCKET`             | `your-audio-bucket` | S3 bucket name                     |
| `S3_PREFIX`             | `recordings/`       | S3 key prefix                      |
| `AWS_REGION`            | `us-east-1`         | AWS region                         |
| `AWS_ACCESS_KEY_ID`     | -                   | AWS access key                     |
| `AWS_SECRET_ACCESS_KEY` | -                   | AWS secret key                     |
| `S3_ENDPOINT`           | -                   | Custom S3 endpoint (for R2, MinIO) |
| `UPLOAD_RETRY_INTERVAL` | `5000`              | Retry delay in ms                  |
| `UPLOAD_MAX_RETRIES`    | `5`                 | Max upload retry attempts          |
| `UPLOAD_CONCURRENCY`    | `2`                 | Concurrent S3 uploads              |

## File Formats & Sizes

### FLAC Compression

Since FLAC only supports up to 8 channels, we split the 18-channel WAV into 3 groups of 6 channels each:

- `segment_XX_ch01-06.flac` - Channels 1-6
- `segment_XX_ch07-12.flac` - Channels 7-12
- `segment_XX_ch13-18.flac` - Channels 13-18

This provides lossless compression with significant size reduction:

| Scenario                            | WAV Size | Total FLAC Size | Savings |
| ----------------------------------- | -------- | --------------- | ------- |
| All 18 channels active (loud)       | ~74 MB   | ~35-50 MB       | 30-50%  |
| Some channels silent                | ~74 MB   | ~10-30 MB       | 60-85%  |
| Mostly silent (few active channels) | ~74 MB   | ~1-5 MB         | 93-98%  |

Silent channels compress to almost nothing, making FLAC ideal for multi-channel recording where not all inputs are used.

### File Naming

**Sender (local)**:
- WAV (temporary): `./recordings/{session_id}/jack_capture.00.wav`
- FLAC (after compression): `./recordings/{session_id}/segment_00_ch01-06.flac`, etc.

**Receiver**:
- Local: `./received/{session_id}/{timestamp}_seg00001.flac`
- S3: `recordings/{session_id}/{timestamp}_seg00001.flac`

## API Endpoints

### POST /stream

Upload audio segment.

Headers:
- `Content-Type: audio/flac` (or `audio/wav`)
- `X-Session-ID: your-session-id`
- `X-Sample-Rate: 48000`
- `X-Channels: 18`
- `X-Segment-Number: 0` (optional, for segmented mode)

### GET /health

Health check and queue status.

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
  }
}
```

### GET /sessions

List recorded sessions and their segments.

### POST /retry-failed

Retry any failed S3 uploads.

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

# Custom path via FINISH_TRIGGER_PATH
FINISH_TRIGGER_PATH=/home/pi/stop-recording touch /home/pi/stop-recording
```

The sender will:
1. Stop `jack_capture` gracefully
2. Wait for the final segment to be written
3. Upload any remaining segments
4. Exit cleanly

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
sudo apt install jack-capture jackd2 ffmpeg
```

### "Could not connect port"

Check the exact port names:

```bash
jack_lsp | grep capture
```

Then set `JACK_PORT_PREFIX` to match.

### "S3 upload failed"

1. Check AWS credentials are set
2. Verify bucket exists and you have write access
3. Check S3_ENDPOINT for non-AWS services

### Large file uploads timing out

If uploads still fail:

- Increase server timeout
- Use shorter `SEGMENT_DURATION` on the sender (e.g., 15 seconds)
- Check network connectivity

### Files not being detected for upload

Ensure the watcher is running. Check logs for:
```
Started watching for segment files
```

The watcher looks for files matching `jack_capture.XX.wav` pattern.

## Project Structure

```
pi-streamer/
├── sender/                 # Runs on device with XR18
│   └── src/
│       ├── index.ts       # Main entry point
│       ├── recorder.ts    # jack_capture recording logic
│       ├── watcher.ts     # File watcher for completed segments
│       ├── compress.ts    # WAV to FLAC compression (splits into channel groups)
│       ├── upload.ts      # Upload queue management
│       ├── jack.ts        # JACK utilities
│       ├── config.ts      # Configuration
│       ├── logger.ts      # Logging (pino)
│       └── utils.ts       # Utility functions
│
├── receiver/               # Runs on server
│   └── server.ts          # HTTP server + S3 upload queue
│
└── README.md
```
