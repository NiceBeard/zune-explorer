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
On first launch, macOS may show a security warning. To open:
1. Right-click the app and choose "Open"
2. Click "Open" in the security dialog

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
3. Check that you're using a compatible Node.js version (14.x or higher)