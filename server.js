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
    transports: ['polling', 'websocket'],
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 20000
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

// ─── Spotify API (Client Credentials) ─────────────────────
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
    if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
    try {
        const resp = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
            },
            body: 'grant_type=client_credentials'
        });
        const data = await resp.json();
        if (data.access_token) {
            spotifyToken = data.access_token;
            spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
            return spotifyToken;
        }
    } catch (e) { console.error('Spotify auth error:', e); }
    return null;
}

async function spotifySearch(query, limit = 5) {
    const token = await getSpotifyToken();
    if (!token) return null;
    try {
        const resp = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const data = await resp.json();
        return (data.tracks?.items || []).map(t => ({
            spotifyId: t.id,
            title: `${t.artists.map(a => a.name).join(', ')} - ${t.name}`,
            artist: t.artists.map(a => a.name).join(', '),
            trackName: t.name,
            thumbnail: t.album?.images?.[0]?.url || '',
            duration: Math.round(t.duration_ms / 1000),
            album: t.album?.name || ''
        }));
    } catch (e) { console.error('Spotify search error:', e); }
    return null;
}

async function resolveYouTubeId(artist, track) {
    try {
        const r = await ytSearch(`${artist} ${track} official audio`);
        return r.videos.length > 0 ? r.videos[0].videoId : null;
    } catch (e) { return null; }
}

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

// 3. Search API — Spotify first, fallback to YouTube
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        // Try Spotify first
        const spotifyResults = await spotifySearch(query);
        if (spotifyResults && spotifyResults.length > 0) {
            return res.json(spotifyResults.map(t => ({
                title: t.title,
                author: t.artist,
                thumbnail: t.thumbnail,
                duration: t.duration,
                album: t.album,
                spotifyId: t.spotifyId,
                trackName: t.trackName,
                artist: t.artist,
                source: 'spotify'
            })));
        }

        // Fallback to yt-search
        const r = await ytSearch(query);
        const videos = r.videos.slice(0, 5).map(v => ({
            videoId: v.videoId,
            title: v.title,
            thumbnail: v.thumbnail,
            author: v.author.name,
            source: 'youtube'
        }));
        res.json(videos);
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// 4. Resolve YouTube video ID from Spotify track
app.get('/api/resolve-yt', async (req, res) => {
    const { artist, track } = req.query;
    if (!artist || !track) return res.status(400).json({ error: 'artist and track required' });
    try {
        const videoId = await resolveYouTubeId(artist, track);
        if (videoId) return res.json({ videoId });
        res.status(404).json({ error: 'No YouTube match found' });
    } catch (err) {
        res.status(500).json({ error: 'Resolve failed' });
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

    socket.on('REMOVE_FROM_QUEUE', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) return;
        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;
        const index = data.index;
        if (typeof index !== 'number' || index < 0 || index >= room.queue.length) return;
        room.queue.splice(index, 1);
        io.to(sessionId).emit('QUEUE_UPDATE', room.queue);
    });

    socket.on('REORDER_QUEUE', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) return;
        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;
        const { fromIndex, toIndex } = data;
        if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') return;
        if (fromIndex < 0 || fromIndex >= room.queue.length) return;
        if (toIndex < 0 || toIndex >= room.queue.length) return;
        const [item] = room.queue.splice(fromIndex, 1);
        room.queue.splice(toIndex, 0, item);
        io.to(sessionId).emit('QUEUE_UPDATE', room.queue);
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
