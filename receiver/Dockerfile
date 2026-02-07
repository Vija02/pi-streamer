# Build stage for web frontend
FROM oven/bun:1 AS web-builder

WORKDIR /app/web

# Copy web package files
COPY web/package.json web/bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy web source
COPY web/ ./

# Build the frontend
RUN bun run build

# Main stage
FROM oven/bun:1

# Install ffmpeg for audio processing
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy server source files
COPY *.ts ./

# Copy built frontend from web-builder stage
COPY --from=web-builder /app/web/dist ./web/dist

# Create data directories
RUN mkdir -p /app/data /app/received

# Set environment variables
ENV PORT=3000
ENV LOCAL_STORAGE_DIR=/app/received
ENV DB_PATH=/app/data/receiver.db

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Run the server
CMD ["bun", "run", "server.ts"]
