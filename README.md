# Zune Explorer

A file explorer inspired by the Zune HD interface, built with Electron. Features a panoramic horizontal scrolling UI with files organized into categories.

## Features

- **Horizontal panoramic navigation** between file categories
- **Dark theme** with Zune HD-inspired orange accent colors
- Files automatically organized into **music**, **videos**, **pictures**, **documents**, and **applications**
- Recently accessed files surfaced via macOS Spotlight metadata
- Native app icon extraction for `.app` files
- Frameless window with custom title bar

## Requirements

- macOS (uses `mdfind`, `mdls`, and `sips` for file metadata and icon conversion)
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
