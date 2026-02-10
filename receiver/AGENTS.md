# Receiver - Agent Guidelines

## Project Overview

The receiver is an HTTP server that receives 18-channel audio streams from the sender, stores them locally, processes them into individual MP3 files with waveforms and HLS streaming support, and optionally uploads to S3. It also serves a web UI for browsing and playing back recordings.

## Tech Stack

- **Runtime**: Bun (required - uses Bun-specific APIs for S3 and SQLite)
- **Web Framework**: Hono (Bun-optimized, lightweight)
- **Database**: SQLite via `bun:sqlite`
- **Web UI**: React + Vite + Tailwind CSS v4
- **Audio Processing**: FFmpeg + audiowaveform (must be installed on system)

## Architecture

The codebase follows a clean separation of concerns:

```
receiver/
├── server.ts              # Entry point (~90 lines) - initializes and starts server
├── config.ts              # Centralized configuration from environment variables
├── db/                    # Database layer
│   ├── index.ts           # Re-exports all db modules
│   ├── connection.ts      # SQLite connection management
│   ├── types.ts           # TypeScript interfaces for DB entities
│   ├── sessions.ts        # Session CRUD operations
│   ├── segments.ts        # Segment CRUD operations
│   ├── channels.ts        # Channel queries
│   ├── pipelineRuns.ts    # Pipeline execution tracking
│   └── recordings.ts      # Recording metadata and tags
├── utils/                 # Utility functions
│   ├── logger.ts          # Structured logging with module prefixes
│   ├── ffmpeg.ts          # FFmpeg command wrappers
│   ├── channelGroups.ts   # Channel group parsing utilities
│   └── paths.ts           # Path generation helpers
├── services/              # Business logic layer
│   ├── index.ts           # Re-exports all services
│   ├── storage.ts         # Unified local file + S3 operations
│   ├── uploadQueue.ts     # Background S3 upload queue with retries
│   └── session.ts         # Session lifecycle management
├── pipeline/              # Step-based audio processing
│   ├── index.ts           # Re-exports
│   ├── types.ts           # StepContext, PipelineData, StepResult interfaces
│   ├── runner.ts          # Pipeline orchestrator with retry logic
│   ├── channelProcessor.ts # Processes single channel through pipeline
│   ├── sessionProcessor.ts # Processes all channels for a session
│   └── steps/             # Individual processing steps
│       ├── base.ts        # BaseStep class with logging helpers
│       ├── index.ts       # Step registry and default pipelines
│       ├── prefetchFlac.ts
│       ├── extractChannel.ts
│       ├── concatenate.ts
│       ├── analyzeAudio.ts
│       ├── normalizeAudio.ts
│       ├── encodeMp3.ts
│       ├── generatePeaks.ts
│       ├── generateHls.ts
│       ├── uploadMp3.ts
│       ├── uploadPeaks.ts
│       └── uploadHls.ts
├── routes/                # Hono HTTP routes
│   ├── index.ts           # Main app with middleware, combines all routes
│   ├── streamRoutes.ts    # POST /stream - receive audio segments
│   ├── sessionRoutes.ts   # /session/* - session lifecycle endpoints
│   ├── apiRoutes.ts       # /api/sessions/* - REST API for sessions
│   ├── mediaRoutes.ts     # Audio/peaks/HLS file serving
│   ├── healthRoutes.ts    # GET /health
│   ├── uploadRoutes.ts    # POST /api/upload - single MP3 uploads
│   ├── adminRoutes.ts     # Pipeline inspection and retry endpoints
│   └── helpers/
│       └── regenerate.ts  # Regeneration helper functions
├── data/                  # SQLite database storage
├── received/              # Local file storage
│   └── {sessionId}/
│       ├── flac/          # Raw FLAC segments by channel group
│       ├── mp3/           # Processed MP3 files
│       ├── peaks/         # Waveform JSON files
│       ├── hls/           # HLS streaming files (.m3u8 + .ts segments)
│       └── temp/          # Temporary processing files
└── web/                   # React frontend
    ├── src/
    │   ├── App.tsx
    │   └── index.css
    └── dist/              # Built frontend (served by server)
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
3. **processing** - Pipeline extracting channels and encoding
4. **processed** - All outputs created successfully
5. **failed** - Processing encountered an error

### Pipeline Architecture

The processing pipeline is step-based for fine-grained control and retry capability:

1. **prefetchFlac** - Gather FLAC segments for a channel group
2. **extractChannel** - Extract single channel from multi-channel FLAC
3. **concatenate** - Concatenate all segments for a channel
4. **analyzeAudio** - Analyze audio levels and characteristics
5. **normalizeAudio** - Normalize audio levels (optional)
6. **encodeMp3** - Encode to MP3 (320kbps default)
7. **generatePeaks** - Generate waveform peaks JSON via audiowaveform
8. **generateHls** - Generate HLS playlist and segments
9. **uploadMp3** - Upload MP3 to S3
10. **uploadPeaks** - Upload peaks to S3
11. **uploadHls** - Upload HLS files to S3

Each step execution is tracked in the `pipeline_runs` table for observability. Failed steps can be retried individually via the admin API.

### Database Tables

- **sessions** - Recording sessions with status and timestamps
- **segments** - Individual FLAC segments received
- **channels** - Processed channel outputs
- **pipeline_runs** - Tracks each step execution (step name, status, duration, error)
- **recordings** - Recording metadata (title, description, tags)

## API Endpoints

### Stream Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/stream` | Upload audio segment |

### Session Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/session/complete` | Mark session complete |
| POST | `/session/process` | Manually trigger processing |
| POST | `/session/regenerate` | Regenerate outputs for a session |

### API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Get session details |
| GET | `/api/sessions/:id/channels` | Get channel info and URLs |
| DELETE | `/api/sessions/:id` | Delete a session |
| GET | `/api/sessions/:id/recording` | Get recording metadata |
| PATCH | `/api/sessions/:id/recording` | Update recording metadata/tags |

### Media Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET/HEAD | `/api/sessions/:id/channels/:num/audio` | Stream MP3 file |
| GET | `/api/sessions/:id/channels/:num/peaks` | Get waveform peaks JSON |
| GET | `/api/sessions/:id/channels/:num/hls/:file` | Stream HLS files |

### Upload Endpoint
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/upload` | Upload single MP3 with metadata |

### Admin Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/pipeline-runs` | List all pipeline runs |
| GET | `/api/admin/pipeline-runs/:sessionId` | Get runs for a session |
| GET | `/api/admin/pipeline-runs/:sessionId/:channel` | Get runs for a channel |
| POST | `/api/admin/pipeline-runs/:runId/retry` | Retry a failed step |
| GET | `/api/admin/stats` | Get processing statistics |

### Other Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check & queue status |
| GET | `/*` | Static files (web UI) |

## Running the Server

```bash
# Development
bun run dev

# Production
bun run start

# Build web UI
bun run build:web
```

## Environment Variables

See `.env.example` for all options. Key ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `LOCAL_STORAGE_DIR` | ./received | Local file storage directory |
| `S3_ENABLED` | true | Enable S3 uploads |
| `S3_BUCKET` | - | S3 bucket name |
| `S3_PREFIX` | - | S3 key prefix |
| `S3_REGION` | us-east-1 | AWS region |
| `MP3_BITRATE` | 320k | MP3 encoding bitrate |
| `SESSION_TIMEOUT_MS` | 30000 | Session timeout before auto-complete |

## Common Issues

### FFmpeg Concat Paths

The concat file for FFmpeg must use absolute paths (via `resolve()`), not relative paths, because FFmpeg resolves paths relative to the concat file location.

### HEAD Requests

Browsers send HEAD requests when preloading audio. The audio endpoint must handle both GET and HEAD methods.

### Audiowaveform Installation

The `audiowaveform` tool is required for waveform generation. Install from: https://github.com/bbc/audiowaveform

On Ubuntu/Debian:
```bash
sudo add-apt-repository ppa:chris-needham/ppa
sudo apt update
sudo apt install audiowaveform
```

## Testing

```bash
# Health check
curl http://localhost:3000/health | jq

# List sessions
curl http://localhost:3000/api/sessions | jq

# Get session details
curl http://localhost:3000/api/sessions/{sessionId} | jq

# Stream audio
curl http://localhost:3000/api/sessions/{sessionId}/channels/1/audio -o test.mp3

# Get waveform peaks
curl http://localhost:3000/api/sessions/{sessionId}/channels/1/peaks | jq

# Trigger processing manually
curl -X POST http://localhost:3000/session/process \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "20260208004253"}'

# View pipeline runs for a session
curl http://localhost:3000/api/admin/pipeline-runs/{sessionId} | jq

# Retry a failed pipeline step
curl -X POST http://localhost:3000/api/admin/pipeline-runs/{runId}/retry

# Upload a single MP3
curl -X POST http://localhost:3000/api/upload \
  -F "file=@recording.mp3" \
  -F "title=My Recording" \
  -F "tags=live,concert"
```

## Adding New Pipeline Steps

1. Create a new file in `pipeline/steps/` extending `BaseStep`
2. Implement the `execute(context, data)` method
3. Register the step in `pipeline/steps/index.ts`
4. Add to the appropriate pipeline in the step registry

Example:
```typescript
// pipeline/steps/myNewStep.ts
import { BaseStep } from "./base";
import type { StepContext, PipelineData, StepResult } from "../types";

export class MyNewStep extends BaseStep {
  name = "myNewStep";

  async execute(context: StepContext, data: PipelineData): Promise<StepResult> {
    this.log(context, "Starting my new step");
    
    // Do work here...
    
    return {
      success: true,
      data: { ...data, myNewOutput: "result" },
    };
  }
}
```

## Adding New Routes

1. Create a new file in `routes/` (e.g., `myRoutes.ts`)
2. Export a Hono instance with routes
3. Mount in `routes/index.ts`

Example:
```typescript
// routes/myRoutes.ts
import { Hono } from "hono";

const app = new Hono();

app.get("/my-endpoint", (c) => {
  return c.json({ message: "Hello" });
});

export default app;

// routes/index.ts
import myRoutes from "./myRoutes";
app.route("/api/my", myRoutes);
```
