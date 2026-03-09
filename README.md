# Ram Jam

## Project Title
Ram Jam: Real-Time Collaborative Music Listening Rooms

## Project Overview
Ram Jam is a Node.js + Socket.IO web app where two participants join the same room and listen to synchronized YouTube audio playback.

## Motivation
The project was built to explore low-latency event synchronization, resilient media control over WebSockets, and practical multiplayer UX patterns.

## Features
- Session-based rooms with host/listener roles
- Real-time play, pause, seek, and track-switch synchronization
- Queue management (add, remove, reorder, next)
- Shared in-room chat
- Search pipeline with Spotify metadata and YouTube fallback
- Auto-recovery behavior for disconnects and session lifecycle events

## Tech Stack
- Node.js (runtime)
- Express (HTTP server)
- Socket.IO (real-time communication)
- Vanilla HTML/CSS/JS frontend
- YouTube iframe player integration

## Architecture Explanation
The server owns room state (`users`, `queue`, `currentVideo`).
- Clients emit interaction events (`JOIN_SESSION`, `CONTROL_EVENT`, `ADD_TO_QUEUE`, etc.)
- Server validates and normalizes payloads
- Server broadcasts canonical state updates to all room members

See [docs/architecture.md](docs/architecture.md) for details.

## Installation Instructions
```bash
npm install
```

Optional environment variables:
- `PORT` (default `3000`)
- `YOUTUBE_API_KEY` (comma-separated keys supported)
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`

## Usage Example
```bash
npm run start
```
Open `http://localhost:3000`, share the generated `/session/<ID>` URL, and start queueing tracks.

## Example Output
Sample events are in [examples/socket-events.md](examples/socket-events.md).

## Testing
```bash
npm test
```

## Future Improvements
- Persistent room history with Redis/PostgreSQL
- Multi-room analytics dashboard
- Rate limiting and abuse controls for chat/search APIs
- End-to-end browser tests in CI
