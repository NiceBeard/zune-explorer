# Zune Explorer - Development Guide

## Project Overview
A Zune HD-inspired file explorer built with Electron, featuring a panoramic horizontal scrolling interface.

## Zune HD Design Principles
Based on the Zune HD interface design:

### Typography
- Large, bold section headers (60px+ font size) as primary navigation
- Clean, sans-serif typography (Segoe UI preferred)
- High contrast text on dark backgrounds

### Color Scheme
- Background: Pure black (#000000) to dark gray (#0a0a0a)
- Accent colors: Orange (#ff6900) to magenta gradient
- Text: White (#ffffff) for primary, light gray (#b0b0b0) for secondary
- Interactive elements use orange highlights

### Layout Structure
- Horizontal panoramic scrolling interface
- Full viewport width sections placed side-by-side
- Smooth momentum scrolling between sections
- Vertical scrolling within sections for overflow content

### File Categories
The app organizes files into 5 main sections:
1. **music** - Audio files (.mp3, .wav, .m4a, .flac)
2. **videos** - Video files (.mp4, .mov, .avi, .mkv)
3. **pictures** - Image files (.jpg, .png, .gif, .svg)
4. **documents** - Document files (.pdf, .txt, .doc, .xlsx)
5. **applications** - Executable files (.app, .exe, .dmg)

### Interaction Design
- Smooth horizontal scrolling via mouse wheel, trackpad, and arrow keys
- Optional section snapping to viewport edges
- Touch-friendly with large hit targets
- Subtle animations and transitions

## Development Commands
```bash
npm start     # Run the application
npm run dev   # Run in development mode with DevTools
npm run build # Build for distribution
```

## Testing Checklist
- [ ] Horizontal scrolling works smoothly
- [ ] Files are correctly categorized by extension
- [ ] Section headers are prominently displayed
- [ ] Dark theme with proper contrast
- [ ] Smooth animations and transitions
- [ ] Empty sections show appropriate placeholders
- [ ] File metadata (size, date) is displayed correctly