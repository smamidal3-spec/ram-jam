# Design Decisions

## Why Socket.IO
Socket.IO simplifies connection lifecycle handling, reconnection, and fallback transports for collaborative state updates.

## Why Server-Owned Room State
Single source of truth on the server avoids divergent queues/playback state across clients.

## Why Utility Extraction
Normalization and validation logic moved to `src/utils/session.js` to improve testability and reduce regressions.
