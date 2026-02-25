# Zune Explorer

A file explorer inspired by the Zune HD interface, built with Electron. Features a panoramic horizontal scrolling UI with files organized into categories.

## Features

- **Horizontal panoramic navigation** between file categories
- **Dark theme** with Zune HD-inspired orange accent colors
- Files automatically organized into **music**, **videos**, **pictures**, **documents**, and **applications**
- **Documents** category provides a browsable file system with smart root directories
- Recently accessed files surfaced via platform-native APIs
- Native app icon extraction
- Frameless window with custom title bar on Windows

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
