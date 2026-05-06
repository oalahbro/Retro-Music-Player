# RetroPlayer

Web-based M3U music player with a retro/Winamp-inspired UI. Built with vanilla HTML, CSS, and JavaScript — no frameworks, no dependencies.

## Features

### Player
- **M3U Playlist Support** — Load `.m3u` / `.m3u8` playlists via file upload, URL, or drag & drop
- **Retro LCD Display** — Scrolling track title, time counter, bitrate, frequency, and channel info
- **Audio Visualizer** — Real-time canvas-based audio visualization
- **Transport Controls** — Play, Pause, Stop, Previous, Next
- **Shuffle & Repeat** — Shuffle mode and repeat (off / all / one)
- **Volume Control** — Slider with mute toggle (desktop: GainNode, iOS: hardware buttons)
- **Playlist Editor** — Add, remove, reorder, and clear tracks
- **Playlist Search** — Real-time filter to quickly find tracks in large playlists
- **Media Library** — LAN-shared playlist library with auto-save (requires server)

### Auto Lyrics
- **lrclib.net Integration** — Automatically fetches lyrics when a track plays
- **Synced Lyrics** — LRC format support with real-time scrolling that follows the music
- **Plain Lyrics Fallback** — Shows plain text lyrics when synced version is unavailable
- **Smart Title Matching** — Cleans track titles (strips extensions, brackets, track numbers) for better search results
- **In-memory Cache** — Avoids re-fetching lyrics for previously played tracks

### Sleep Timer
- **Configurable Duration** — Choose from 5, 10, 15, 30, or 60 minutes
- **Countdown Display** — Shows remaining time next to the sleep LED indicator
- **Fade Out** — Gradually reduces volume over 5 seconds before pausing
- **Cancel Anytime** — Click the sleep button again to cancel an active timer

### iOS / Mobile
- **Background Playback** — Music continues playing when the app is minimized or screen is locked
- **Lock Screen Controls** — Play, pause, skip next/previous from iOS Control Center and lock screen
- **Media Session Artwork** — Randomized retro-themed thumbnails with track title (10 color themes x 6 icon styles)
- **Mobile Tab Navigation** — Now Playing, Playlist, Library, and Lyrics tabs
- **Touch-optimized UI** — Larger buttons and sliders for mobile interaction

### Reliability
- **Network Error Retry** — Retries failed tracks up to 3 times with exponential backoff (2s, 5s, 10s)
- **Offline Detection** — Pauses retries when offline, auto-resumes when connection returns
- **Skip-fast Protection** — Suppresses stale errors when rapidly switching tracks
- **State Persistence** — Remembers playlist, volume, position, shuffle/repeat across sessions
- **Debug Log Panel** — In-app log viewer (tap LOG button) for troubleshooting on mobile

### Server
- **CORS Proxy** — Built-in proxy with retry logic and realistic browser User-Agent
- **Google Drive Support** — Auto-resolves confirmation tokens and handles cookies for Google Drive audio URLs
- **File Logging** — Persistent server logs at `logs/server.log`
- **REST API for playlists:**
  - `GET /api/playlists` — List all saved playlists
  - `GET /api/playlists/<id>` — Get a specific playlist with tracks
  - `POST /api/playlists` — Save a new playlist `{ name, tracks }`
  - `DELETE /api/playlists/<id>` — Delete a saved playlist

## Getting Started

### Simple (static files only)

Open `index.html` in your browser. Library, proxy, and lyrics features won't be available.

### With Server (recommended)

```bash
# Start the dev server
python server.py

# Or specify a custom port/host
python server.py --port 8765 --host 0.0.0.0
```

Then open `http://localhost:8765/` in your browser. Other devices on the same WiFi/LAN can also access the player.

## Project Structure

```
music-player/
├── index.html              # Main HTML (player, playlist, library, lyrics windows)
├── server.py               # Python dev server (proxy + library API + logging)
├── .gitignore
├── add_download_param.py   # Utility script
├── sample.m3u              # Sample playlist file
├── assets/                 # Static assets
├── css/
│   └── main.css            # All styles (retro Winamp theme + responsive)
├── js/
│   ├── app.js              # Entry point, feature wiring, lyrics, sleep timer, debug log
│   ├── player.js           # Audio element wrapper (Web Audio API + iOS detection)
│   ├── playlist.js         # Playlist state management
│   ├── visualizer.js       # Canvas audio visualizer
│   ├── library.js          # Media library (server API client)
│   ├── ui.js               # DOM bindings, modals, rendering, search filter
│   ├── m3u-parser.js       # M3U/M3U8 file parser
│   └── storage.js          # LocalStorage persistence
├── playlists/              # Server-side saved playlists (JSON)
└── logs/                   # Server logs (auto-generated)
```

## Supported Audio Formats

Depends on your browser's native `<audio>` support: MP3, AAC, OGG, WAV, FLAC, WebM Audio, etc.

## Requirements

- Any modern browser (Chrome, Firefox, Edge, Safari)
- Python 3.7+ (only for server mode)

## License

MIT
