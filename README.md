# RetroPlayer

Web-based M3U music player with a retro/Winamp-inspired UI. Built with vanilla HTML, CSS, and JavaScript — no frameworks, no dependencies.

## Features

- **M3U Playlist Support** — Load `.m3u` / `.m3u8` playlists via file upload, URL, or drag & drop
- **Retro LCD Display** — Scrolling track title, time counter, bitrate, frequency, and channel info
- **Audio Visualizer** — Real-time canvas-based audio visualization
- **Transport Controls** — Play, Pause, Stop, Previous, Next
- **Shuffle & Repeat** — Shuffle mode and repeat (off / all / one)
- **Volume Control** — Slider with mute toggle
- **Playlist Editor** — Add, remove, reorder, and clear tracks
- **Media Library** — LAN-shared playlist library with auto-save (requires server)
- **CORS Proxy** — Built-in proxy server to bypass cross-origin restrictions on audio sources
- **State Persistence** — Remembers playlist, volume, position, shuffle/repeat across sessions
- **Error Handling** — Auto-skips broken tracks with error toast notifications
- **Mobile Responsive** — Tab navigation (Now Playing / Playlist / Library) on mobile
- **Keyboard Friendly** — Standard media transport shortcuts

## Getting Started

### Simple (static files only)

Open `index.html` in your browser. Library and proxy features won't be available.

### With Server (recommended)

```bash
# Start the dev server
python server.py

# Or specify a custom port/host
python server.py --port 8765 --host 0.0.0.0
```

Then open `http://localhost:8765/` in your browser. Other devices on the same WiFi/LAN can also access the player.

### Server Features

- **Static file serving** — Serves the player frontend
- **`/proxy?url=<encoded>`** — Fetches remote audio URLs, strips CORP/CSP headers to bypass browser restrictions
- **REST API for playlists:**
  - `GET /api/playlists` — List all saved playlists
  - `GET /api/playlists/<id>` — Get a specific playlist with tracks
  - `POST /api/playlists` — Save a new playlist `{ name, tracks }`
  - `DELETE /api/playlists/<id>` — Delete a saved playlist

## Project Structure

```
music-player/
├── index.html              # Main HTML
├── server.py               # Python dev server (proxy + library API)
├── add_download_param.py   # Utility script
├── sample.m3u              # Sample playlist file
├── assets/                 # Static assets
├── css/
│   └── main.css            # All styles (retro Winamp theme)
├── js/
│   ├── app.js              # Entry point & module wiring
│   ├── player.js           # Audio element wrapper
│   ├── playlist.js         # Playlist state management
│   ├── visualizer.js       # Canvas audio visualizer
│   ├── library.js          # Media library (server API client)
│   ├── ui.js               # DOM bindings & UI updates
│   ├── m3u-parser.js       # M3U/M3U8 file parser
│   └── storage.js          # LocalStorage persistence
└── playlists/              # Server-side saved playlists (JSON)
```

## Supported Audio Formats

Depends on your browser's native `<audio>` support: MP3, AAC, OGG, WAV, FLAC, WebM Audio, etc.

## Requirements

- Any modern browser (Chrome, Firefox, Edge, Safari)
- Python 3.7+ (only for server mode)

## License

MIT
