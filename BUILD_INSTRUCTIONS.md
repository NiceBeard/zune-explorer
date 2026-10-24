# Building Zune Explorer for Desktop

## Prerequisites
1. Save your icon image as `build-resources/icon.png` (minimum 1024x1024 pixels)
2. Make sure you have Node.js and npm installed

## Quick Build
```bash
# Install dependencies if you haven't already
npm install

# Build the app
./scripts/build-app.sh
```

## Manual Build Steps

### 1. Generate Icon (if you haven't already)
```bash
./scripts/generate-icon.sh build-resources/icon.png
```

### 2. Build the Application
```bash
# For macOS
npm run dist

# Or just build without packaging
npm run pack
```

## Installation

After building, you'll find in the `dist` directory:
- **Zune Explorer-1.0.0.dmg** - DMG installer for macOS
- **Zune Explorer-1.0.0-mac.zip** - ZIP archive

### To Install:
1. Open the DMG file
2. Drag "Zune Explorer" to your Applications folder
3. Eject the DMG
4. Launch Zune Explorer from Applications or Launchpad

### First Launch:
The app is ad-hoc signed (`mac.identity: "-"` in `package.json`) but not notarized, so a downloaded copy shows a "could not verify" warning on first launch. To open:
1. Click "Done" in the warning dialog
2. Open System Settings → Privacy & Security and click "Open Anyway"

To ship a fully trusted build, replace `"identity": "-"` with a Developer ID Application certificate and provide notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

## Development Mode
To run in development mode without building:
```bash
npm start
```

## Troubleshooting

### Icon Not Showing
Make sure your icon.png is at least 1024x1024 pixels and saved in `build-resources/icon.png`

### Build Fails
1. Delete the `dist` directory and try again
2. Make sure all dependencies are installed: `npm install`
3. Check that you're using a compatible Node.js version (22.x or higher)