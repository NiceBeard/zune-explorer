#!/bin/bash
set -euo pipefail

echo "Building Zune Explorer..."

# Check if icon.png exists
if [ ! -f "build-resources/icon.png" ]; then
    echo "❌ Error: Please save your icon as build-resources/icon.png"
    echo "The icon should be at least 1024x1024 pixels"
    exit 1
fi

# Generate .icns file if it doesn't exist
if [ ! -f "build-resources/icon.icns" ]; then
    echo "Generating .icns file from icon.png..."
    ./scripts/generate-icon.sh build-resources/icon.png
fi

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf dist

# Build the app
echo "Building macOS app..."
npm run dist

# Check if build was successful
if [ -d "dist/mac" ] || [ -d "dist/mac-arm64" ]; then
    echo "✅ Build successful!"
    echo ""
    echo "The app has been built in the dist directory."
    echo "You can find:"
    echo "  - DMG installer: dist/*.dmg"
    echo "  - ZIP archive: dist/*.zip"
    echo ""
    echo "To install:"
    echo "1. Open the DMG file"
    echo "2. Drag Zune Explorer to your Applications folder"
    echo "3. Launch from Applications or Launchpad"
else
    echo "❌ Build failed. Please check the error messages above."
    exit 1
fi