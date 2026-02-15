#!/bin/bash
#
# Audio Analysis Script
# Analyzes loudness metrics to determine normalization approach
#
# Usage: ./analyze-audio.sh <audio_file>
#

set -e

FILE="$1"

if [ -z "$FILE" ]; then
  echo "Usage: $0 <audio_file>"
  echo "Example: $0 recording.mp3"
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE"
  exit 1
fi

echo "=== Analyzing: $FILE ==="

# Integrated LUFS
echo -e "\n--- Integrated Loudness (loudnorm) ---"
ffmpeg -i "$FILE" -af loudnorm=print_format=json -f null /dev/null 2>&1 | grep -E '"input_i"|"input_tp"|"input_lra"'

# Volume stats
echo -e "\n--- Volume Stats ---"
ffmpeg -i "$FILE" -af volumedetect -f null /dev/null 2>&1 | grep -E "(max|mean)_volume"

# Get integrated LUFS for calculation
INTEGRATED=$(ffmpeg -i "$FILE" -af loudnorm=print_format=json -f null /dev/null 2>&1 | \
  grep '"input_i"' | sed 's/.*: "//' | sed 's/".*//')

# Get max volume for quiet detection
MAX_VOL=$(ffmpeg -i "$FILE" -af volumedetect -f null /dev/null 2>&1 | \
  grep "max_volume" | sed 's/.*max_volume: //' | sed 's/ dB//')

# Normalization decision
echo -e "\n--- Normalization Decision ---"
echo "Integrated LUFS: $INTEGRATED"
echo "Max volume: $MAX_VOL dB"

TARGET_LUFS=-16
QUIET_THRESHOLD=-40
HIGH_GAIN_THRESHOLD=20

# Check if quiet (max volume below threshold)
if [ -n "$MAX_VOL" ]; then
  IS_QUIET=$(echo "$MAX_VOL < $QUIET_THRESHOLD" | bc 2>/dev/null || echo "0")
  if [ "$IS_QUIET" = "1" ]; then
    echo "Result: QUIET CHANNEL (max $MAX_VOL dB < $QUIET_THRESHOLD dB)"
    echo "Action: Skip normalization (don't amplify noise)"
    echo -e "\n=== Done ==="
    exit 0
  fi
fi

# Calculate gain needed
if [ -n "$INTEGRATED" ] && [ "$INTEGRATED" != "-inf" ]; then
  GAIN_NEEDED=$(echo "$TARGET_LUFS - $INTEGRATED" | bc 2>/dev/null || echo "N/A")
  echo "Gain needed: ${GAIN_NEEDED}dB (to reach $TARGET_LUFS LUFS)"
  
  if [ "$GAIN_NEEDED" != "N/A" ]; then
    USE_HIGH_GAIN=$(echo "$GAIN_NEEDED > $HIGH_GAIN_THRESHOLD" | bc 2>/dev/null || echo "0")
    if [ "$USE_HIGH_GAIN" = "1" ]; then
      echo "Result: HIGH GAIN MODE (${GAIN_NEEDED}dB > ${HIGH_GAIN_THRESHOLD}dB threshold)"
      echo "Action: Use gain+limiter (loudnorm won't apply this much gain)"
    else
      echo "Result: NORMAL MODE"
      echo "Action: Use loudnorm filter"
    fi
  fi
else
  echo "Result: SILENT/INVALID (-inf LUFS)"
  echo "Action: Skip normalization"
fi

echo -e "\n=== Done ==="
