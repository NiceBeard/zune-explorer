#!/bin/bash
set -euo pipefail

# This script generates an .icns file from a PNG icon
# Usage: ./generate-icon.sh path/to/icon.png

if [ $# -eq 0 ]; then
    echo "Usage: $0 path/to/icon.png"
    exit 1
fi

INPUT_PNG="$1"
OUTPUT_DIR="$(dirname "$INPUT_PNG")"
ICONSET_DIR="$OUTPUT_DIR/ZuneExplorer.iconset"

# Create iconset directory
mkdir -p "$ICONSET_DIR"

# Generate different sizes
sips -z 16 16     "$INPUT_PNG" --out "$ICONSET_DIR/icon_16x16.png"
sips -z 32 32     "$INPUT_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png"
sips -z 32 32     "$INPUT_PNG" --out "$ICONSET_DIR/icon_32x32.png"
sips -z 64 64     "$INPUT_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png"
sips -z 128 128   "$INPUT_PNG" --out "$ICONSET_DIR/icon_128x128.png"
sips -z 256 256   "$INPUT_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png"
sips -z 256 256   "$INPUT_PNG" --out "$ICONSET_DIR/icon_256x256.png"
sips -z 512 512   "$INPUT_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png"
sips -z 512 512   "$INPUT_PNG" --out "$ICONSET_DIR/icon_512x512.png"
sips -z 1024 1024 "$INPUT_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png"

# Generate .icns file
iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_DIR/icon.icns"

# Clean up
rm -rf "$ICONSET_DIR"

echo "Icon generated at: $OUTPUT_DIR/icon.icns"