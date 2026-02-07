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
│  (USB/Net)  │               │  (FFmpeg)    │  (per segment)    │  (Bun/Node)  │
└─────────────┘               └──────────────┘                   └──────────────┘
                                    │                                   │
                                    │ 1. Save                           │ 1. Save
                                    │    locally                        │    locally
                                    │                                   │
                                    │ 2. Upload                         │ 2. Queue for
                                    │    segment                        │    S3 upload
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

## Requirements

### Sender (Linux machine with XR18)

- Bun runtime
- JACK audio server (`jackd2`)
- FFmpeg with JACK support

```bash
# Ubuntu/Debian
sudo apt install jackd2 ffmpeg

# Arch
sudo pacman -S jack2 ffmpeg

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
cd streaming/sender

# Install dependencies
bun install

# Test JACK setup first
bun run index.ts test

# Configure (adjust JACK_PORT_PREFIX if needed)
export STREAM_URL="http://your-server:3000/stream"
export JACK_PORT_PREFIX="system:capture_"

# Start recording
bun run start

# Retry any failed uploads
bun run index.ts upload-pending
```

### 5. Setup Receiver

```bash
cd streaming/receiver

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

| Variable             | Default                        | Description               |
| -------------------- | ------------------------------ | ------------------------- |
| `STREAM_URL`         | `http://localhost:3000/stream` | Receiver endpoint         |
| `RECORDING_DIR`      | `./recordings`                 | Local recording directory |
| `SAMPLE_RATE`        | `48000`                        | Audio sample rate         |
| `CHANNELS`           | `18`                           | Number of channels        |
| `JACK_PORT_PREFIX`   | `system:capture_`              | JACK port prefix          |
| `SESSION_ID`         | (timestamp)                    | Unique session ID         |
| `SEGMENT_DURATION`   | `30`                           | Segment length in seconds |
| `UPLOAD_ENABLED`     | `true`                         | Enable server upload      |
| `UPLOAD_RETRY_COUNT` | `3`                            | Upload retry attempts     |

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

## API Endpoints

### POST /stream

Upload audio data.

Headers:

- `Content-Type: audio/flac`
- `X-Session-ID: your-session-id`
- `X-Sample-Rate: 48000`
- `X-Channels: 18`
- `X-Segment-Number: 0` (optional, for segmented mode)

### GET /health

Health check.

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

## Syncing with Video

The recordings include timestamps in the filename. To sync with separately recorded video:

1. **Use timecode**: Start both recordings at a known time (clap, slate)
2. **Match timestamps**: Filename includes `YYYYMMDD_HHMMSS`
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

The receiver uses multipart upload for files > 5MB. If uploads still fail:

- Increase server timeout
- Use shorter `SEGMENT_DURATION` on the sender
