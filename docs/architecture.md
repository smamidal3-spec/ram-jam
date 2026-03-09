# Architecture

## Components
- `server.js`: Express + Socket.IO entrypoint and room orchestration
- `public/`: browser UI and client sync logic
- `src/utils/session.js`: shared normalization/sanitization helpers
- `tests/`: unit tests for server-side utility behavior

## Runtime Flow
1. User requests `/` and is redirected to `/session/:id`
2. Client emits `JOIN_SESSION`
3. Server creates/loads room state and assigns host if needed
4. Host emits playback and queue events
5. Server validates payloads and relays canonical events to listeners
6. On disconnect, server rebalances host or terminates room

## Data Model
A room stores:
- `hostSocketId`
- `users` (socket ids)
- `queue` (normalized video items)
- `currentVideo`

## Sync Strategy
- Host sends `SYNC_EVENT` snapshots periodically
- Listener applies correction with drift thresholds
- Full sync can be requested after reconnect/join

See [../assets/architecture.svg](../assets/architecture.svg) for the diagram.
