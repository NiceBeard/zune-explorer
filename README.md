# Zune Explorer

A file explorer inspired by the Zune HD interface, built with Electron. Features a panoramic horizontal scrolling UI with files organized into categories.
<img width="1276" height="715" alt="image" src="https://github.com/user-attachments/assets/48113e85-121e-4ff3-b28a-99679dde9df9" />

## Features

- **Horizontal panoramic navigation** between file categories
- **Dark theme** with Zune HD-inspired orange accent colors
- Files automatically organized into **music**, **videos**, **pictures**, **documents**, and **applications**
- **Documents** category provides a browsable file system with smart root directories
- Recently accessed files surfaced via platform-native APIs
- Native app icon extraction
- Frameless window with custom title bar on Windows
- Built-in music player will fetch album art

## Supported Platforms

- **macOS** — uses Spotlight (`mdfind`, `mdls`) for recent files, `sips` for icon conversion
- **Windows** — uses Windows Recent folder for recent files, Start Menu for application discovery

## Requirements

- Node.js 14+

## Getting Started

```bash
# Install dependencies
npm install

# Run the app
npm start

# Run in development mode (with DevTools)
npm run dev
```

## Building

```bash
# Build distributable
npm run build
```

See [BUILD_INSTRUCTIONS.md](BUILD_INSTRUCTIONS.md) for detailed build and installation steps.

## License

[MIT](LICENSE)
