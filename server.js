const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const ytSearch = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket'],
    pingInterval: 10000,
    pingTimeout: 5000
});

// Serve frontend static files without cache to force reload HTML/JS/CSS updates
app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));
app.use(express.json());

// In-memory Room State
const rooms = {};

// Helper to generate a room ID
function generateSessionId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A1B2C3"
}

function normalizeSessionId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed;
}

function getSessionIdFromReferer(referer) {
    if (typeof referer !== 'string' || !referer) return null;
    try {
        const url = new URL(referer);
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'session' && parts[1]) {
            return normalizeSessionId(parts[1]);
        }
    } catch (err) {
        return null;
    }
    return null;
}

function getJoinedRoom(sessionId, socketId) {
    const room = rooms[sessionId];
    if (!room) return null;
    if (!room.users.includes(socketId)) return null;
    return room;
}

// Routes
// 1. Root: create session and redirect
app.get('/', (req, res) => {
    const sessionId = generateSessionId();
    res.redirect(`/session/${sessionId}`);
});

// 2. Session route: serves the main app
app.get('/session/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 3. Search API
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        const r = await ytSearch(query);
        // Return top 5 video results
        const videos = r.videos.slice(0, 5).map(v => ({
            videoId: v.videoId,
            title: v.title,
            thumbnail: v.thumbnail,
            author: v.author.name
        }));
        res.json(videos);
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// WebSockets
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('JOIN_SESSION', (payload) => {
        // Accept both legacy (string) and structured payloads.
        const sessionId =
            normalizeSessionId(typeof payload === 'string' ? payload : payload?.sessionId) ||
            getSessionIdFromReferer(socket.handshake.headers?.referer);

        if (!sessionId) {
            socket.emit('JOIN_ERROR', { message: 'Invalid session id' });
            return;
        }

        // Initialize room if it doesn't exist
        if (!rooms[sessionId]) {
            rooms[sessionId] = {
                hostSocketId: socket.id,
                users: [],
                queue: [], // Array of { videoId, title, timestamp }
                currentVideo: null
            };
        }

        const room = rooms[sessionId];

        const alreadyJoined = room.users.includes(socket.id);

        // Check room limit
        if (!alreadyJoined && room.users.length >= 2) {
            socket.emit('SESSION_FULL');
            return;
        }

        // Add user
        if (!alreadyJoined) {
            room.users.push(socket.id);
        }
        socket.join(sessionId);

        // Determine role
        const isHost = (socket.id === room.hostSocketId);

        console.log(`${socket.id} joined room ${sessionId} as ${isHost ? 'Host' : 'Listener'}`);

        // Welcome event
        socket.emit('JOIN_SUCCESS', {
            sessionId,
            isHost,
            queue: room.queue,
            currentVideo: room.currentVideo,
            userCount: room.users.length
        });

        // Notify others
        socket.to(sessionId).emit('USER_JOINED', { userCount: room.users.length });

        // Request a full sync from host if a listener just joined
        if (!isHost && room.hostSocketId) {
            io.to(room.hostSocketId).emit('REQUEST_FULL_SYNC');
        }

        // Store sessionId on socket to simplify disconnect handling
        socket.data.sessionId = sessionId;
    });

    socket.on('CONTROL_EVENT', (data) => {
        // data = { sessionId, type, time, issuedAt, ... }
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) return;

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;

        // Host is authoritative for most controls; allow PLAY/PAUSE from any user.
        if (socket.id !== room.hostSocketId && !['PLAY', 'PAUSE'].includes(data?.type)) return;

        if (data?.type === 'VIDEO_CHANGE' && data?.videoId) {
            room.currentVideo = {
                videoId: data.videoId,
                title: data.title || `Track ${data.videoId}`,
                thumbnail: data.thumbnail || `https://img.youtube.com/vi/${data.videoId}/hqdefault.jpg`
            };
        }

        socket.to(sessionId).emit('CONTROL_EVENT', data);
    });

    socket.on('FULL_SYNC_REPLY', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) return;

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;
        if (socket.id !== room.hostSocketId) return;

        socket.to(sessionId).emit('FULL_SYNC', data);
    });

    socket.on('SYNC_EVENT', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) return;

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;
        if (socket.id !== room.hostSocketId) return;

        socket.to(sessionId).emit('SYNC_EVENT', data);
    });

    socket.on('ADD_TO_QUEUE', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        const videoItem = data?.videoItem;
        // videoItem = { videoId, title }
        if (!sessionId || !videoItem?.videoId) return;

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;

        room.queue.push(videoItem);
        // Broadcast updated queue to everyone in the room
        io.to(sessionId).emit('QUEUE_UPDATE', room.queue);
    });

    socket.on('PLAY_NEXT', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) return;

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;
        // Any user in the room can skip.
        // if (socket.id !== room.hostSocketId) return;

        if (room.queue.length > 0) {
            // Remove first item
            const nextVideo = room.queue.shift();
            room.currentVideo = nextVideo; // Preserve full object

            // Update everyone's queue
            io.to(sessionId).emit('QUEUE_UPDATE', room.queue);

            // Force a video change event from the server
            io.to(sessionId).emit('CONTROL_EVENT', {
                sessionId,
                type: 'VIDEO_CHANGE',
                videoId: nextVideo.videoId,
                title: nextVideo.title,
                thumbnail: nextVideo.thumbnail,
                time: 0,
                issuedAt: Date.now()
            });
        }
    });

    socket.on('CHAT_MESSAGE', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) return;
        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;
        const message = (data.message || '').slice(0, 200);
        if (!message) return;
        io.to(sessionId).emit('CHAT_MESSAGE', {
            userId: socket.id,
            userName: (data.userName || 'Anon').slice(0, 20),
            message,
            timestamp: Date.now()
        });
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const sessionId = socket.data.sessionId;

        if (sessionId && rooms[sessionId]) {
            const room = rooms[sessionId];

            // Remove user
            room.users = room.users.filter(id => id !== socket.id);

            if (room.users.length === 0) {
                // Room is empty, delete it
                delete rooms[sessionId];
                console.log(`Room ${sessionId} deleted.`);
            } else {
                // Someone is still in the room
                if (socket.id === room.hostSocketId) {
                    // EC-1: Host disconnects -> End session
                    io.to(sessionId).emit('SESSION_ENDED', { reason: 'Host disconnected' });
                    delete rooms[sessionId];
                } else {
                    // Listener left
                    socket.to(sessionId).emit('USER_LEFT', { userCount: room.users.length });
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Ram Jam server running on http://localhost:${PORT}`);
});
