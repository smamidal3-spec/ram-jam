const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    transports: ['polling', 'websocket'],
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 20000
});

const SESSION_ID_PATTERN = /^[A-Z0-9]{4,16}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;
const ALLOWED_CONTROL_TYPES = new Set(['PLAY', 'PAUSE', 'SEEK', 'VIDEO_CHANGE']);

app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));
app.use(express.json());

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
    if (spotifyToken && Date.now() < spotifyTokenExpiry) {
        return spotifyToken;
    }
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
        return null;
    }

    try {
        const resp = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
            },
            body: 'grant_type=client_credentials'
        });
        const data = await resp.json();
        if (!data.access_token) {
            return null;
        }

        spotifyToken = data.access_token;
        spotifyTokenExpiry = Date.now() + (Math.max(60, data.expires_in || 3600) - 60) * 1000;
        return spotifyToken;
    } catch (err) {
        console.error('Spotify auth error:', err);
        return null;
    }
}

async function spotifySearch(query, limit = 5) {
    const token = await getSpotifyToken();
    if (!token) {
        return null;
    }

    try {
        const resp = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await resp.json();
        return (data.tracks?.items || []).map((track) => ({
            spotifyId: track.id,
            title: `${track.name} - ${track.artists.map((artist) => artist.name).join(', ')}`,
            artist: track.artists.map((artist) => artist.name).join(', '),
            trackName: track.name,
            thumbnail: track.album?.images?.[0]?.url || '',
            duration: Math.round(track.duration_ms / 1000),
            album: track.album?.name || ''
        }));
    } catch (err) {
        console.error('Spotify search error:', err);
        return null;
    }
}

const ytCache = new Map();
const rooms = new Map();

function clampString(value, maxLen) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

function normalizeSessionId(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toUpperCase();
    if (!SESSION_ID_PATTERN.test(normalized)) {
        return null;
    }
    return normalized;
}

function normalizeVideoId(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    if (!VIDEO_ID_PATTERN.test(normalized)) {
        return null;
    }
    return normalized;
}

function sanitizeThumbnail(value, videoId) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^https?:\/\//i.test(trimmed)) {
            return trimmed.slice(0, 500);
        }
    }
    if (videoId) {
        return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }
    return '';
}

function normalizeQueueItem(input) {
    const videoId = normalizeVideoId(input?.videoId);
    if (!videoId) {
        return null;
    }
    const title = clampString(input?.title, 140) || `Track ${videoId}`;
    return {
        videoId,
        title,
        thumbnail: sanitizeThumbnail(input?.thumbnail, videoId)
    };
}

function createRoom(hostSocketId) {
    return {
        hostSocketId,
        users: new Set(),
        queue: [],
        currentVideo: null
    };
}

function cloneQueue(queue) {
    return queue.map((item) => ({ ...item }));
}

function cloneCurrentVideo(currentVideo) {
    return currentVideo ? { ...currentVideo } : null;
}

function ensureRoomHost(room) {
    if (room.users.size === 0) {
        room.hostSocketId = null;
        return;
    }
    if (!room.hostSocketId || !room.users.has(room.hostSocketId)) {
        room.hostSocketId = room.users.values().next().value;
    }
}

function getJoinedRoom(sessionId, socketId) {
    const room = rooms.get(sessionId);
    if (!room || !room.users.has(socketId)) {
        return null;
    }
    return room;
}

function playNextInRoom(sessionId, room) {
    if (room.queue.length === 0) {
        return false;
    }

    const nextVideo = room.queue.shift();
    room.currentVideo = nextVideo;

    io.to(sessionId).emit('QUEUE_UPDATE', cloneQueue(room.queue));
    io.to(sessionId).emit('CONTROL_EVENT', {
        sessionId,
        type: 'VIDEO_CHANGE',
        videoId: nextVideo.videoId,
        title: nextVideo.title,
        thumbnail: nextVideo.thumbnail,
        time: 0,
        issuedAt: Date.now()
    });
    return true;
}

function clearSessionIdForRoomMembers(sessionId, room) {
    for (const memberId of room.users) {
        const memberSocket = io.sockets.sockets.get(memberId);
        if (memberSocket && memberSocket.data.sessionId === sessionId) {
            memberSocket.data.sessionId = null;
        }
    }
}

function removeSocketFromRoom(socket, sessionId) {
    const room = rooms.get(sessionId);
    if (!room || !room.users.has(socket.id)) {
        return;
    }

    const wasHost = socket.id === room.hostSocketId;
    room.users.delete(socket.id);
    socket.leave(sessionId);

    if (room.users.size === 0) {
        rooms.delete(sessionId);
        return;
    }

    if (wasHost) {
        io.to(sessionId).emit('SESSION_ENDED', { reason: 'Host disconnected' });
        clearSessionIdForRoomMembers(sessionId, room);
        rooms.delete(sessionId);
        return;
    }

    ensureRoomHost(room);
    io.to(sessionId).emit('USER_LEFT', { userCount: room.users.size });
}

async function youtubeSearch(query, maxResults = 1) {
    if (!YOUTUBE_API_KEY) return [];
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.items || []).map(item => ({
        videoId: item.id?.videoId,
        title: item.snippet?.title || '',
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
        author: item.snippet?.channelTitle || 'Unknown'
    }));
}

async function resolveYouTubeId(artist, track) {
    const cacheKey = `${artist}||${track}`.toLowerCase();
    if (ytCache.has(cacheKey)) {
        return ytCache.get(cacheKey);
    }

    try {
        const results = await youtubeSearch(`${artist} ${track} official audio`, 1);
        const videoId = results.length > 0 ? results[0].videoId : null;
        if (videoId) {
            ytCache.set(cacheKey, videoId);
        }
        return videoId;
    } catch {
        return null;
    }
}

function generateSessionId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateUniqueSessionId() {
    let sessionId = generateSessionId();
    while (rooms.has(sessionId)) {
        sessionId = generateSessionId();
    }
    return sessionId;
}

function getSessionIdFromReferer(referer) {
    if (typeof referer !== 'string' || !referer) {
        return null;
    }
    try {
        const parsed = new URL(referer);
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts[0] === 'session' && parts[1]) {
            return normalizeSessionId(parts[1]);
        }
    } catch {
        return null;
    }
    return null;
}

app.get('/', (_req, res) => {
    const sessionId = generateUniqueSessionId();
    res.redirect(`/session/${sessionId}`);
});

app.get('/session/:id', (req, res) => {
    const sessionId = normalizeSessionId(req.params.id);
    if (!sessionId) {
        res.status(400).send('Invalid session id');
        return;
    }

    if (sessionId !== req.params.id) {
        res.redirect(`/session/${sessionId}`);
        return;
    }

    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/search', async (req, res) => {
    const query = clampString(req.query.q, 120);
    if (!query) {
        res.status(400).json({ error: 'Query required' });
        return;
    }

    try {
        const spotifyResults = await spotifySearch(query);
        if (spotifyResults && spotifyResults.length > 0) {
            const mapped = spotifyResults.map((track) => ({
                title: track.title,
                author: track.artist,
                thumbnail: track.thumbnail,
                duration: track.duration,
                album: track.album,
                trackName: track.trackName,
                artist: track.artist,
                source: 'spotify'
            }));
            res.json(mapped);
            spotifyResults.forEach((track) => {
                resolveYouTubeId(track.artist, track.trackName).catch(() => { });
            });
            return;
        }
    } catch (err) {
        console.error('Spotify search path failed:', err);
    }

    try {
        const videos = await youtubeSearch(query, 8);
        res.json(videos.map(v => ({ ...v, source: 'youtube' })));
    } catch (err) {
        console.error('YouTube search error:', err);
        res.json([]);
    }
});

app.get('/api/resolve-yt', async (req, res) => {
    const artist = clampString(req.query.artist, 120);
    const track = clampString(req.query.track, 120);
    if (!artist || !track) {
        res.status(400).json({ error: 'artist and track required' });
        return;
    }

    try {
        const videoId = await resolveYouTubeId(artist, track);
        if (!videoId) {
            res.status(404).json({ error: 'No YouTube match found' });
            return;
        }
        res.json({ videoId });
    } catch {
        res.status(500).json({ error: 'Resolve failed' });
    }
});

io.on('connection', (socket) => {
    socket.on('JOIN_SESSION', (payload) => {
        const requestedSessionId = typeof payload === 'string' ? payload : payload?.sessionId;
        const sessionId =
            normalizeSessionId(requestedSessionId) ||
            getSessionIdFromReferer(socket.handshake.headers?.referer);

        if (!sessionId) {
            socket.emit('JOIN_ERROR', { message: 'Invalid session id' });
            return;
        }

        const previousSessionId = normalizeSessionId(socket.data.sessionId);
        if (previousSessionId && previousSessionId !== sessionId) {
            removeSocketFromRoom(socket, previousSessionId);
            socket.data.sessionId = null;
        }

        let room = rooms.get(sessionId);
        if (!room) {
            room = createRoom(socket.id);
            rooms.set(sessionId, room);
        }

        const alreadyJoined = room.users.has(socket.id);
        if (!alreadyJoined && room.users.size >= 2) {
            socket.emit('SESSION_FULL');
            return;
        }

        if (!alreadyJoined) {
            room.users.add(socket.id);
            socket.join(sessionId);
        }

        ensureRoomHost(room);
        socket.data.sessionId = sessionId;

        const isHost = socket.id === room.hostSocketId;
        socket.emit('JOIN_SUCCESS', {
            sessionId,
            isHost,
            queue: cloneQueue(room.queue),
            currentVideo: cloneCurrentVideo(room.currentVideo),
            userCount: room.users.size
        });

        socket.to(sessionId).emit('USER_JOINED', { userCount: room.users.size });
        if (!isHost && room.hostSocketId) {
            io.to(room.hostSocketId).emit('REQUEST_FULL_SYNC');
        }
    });

    socket.on('CONTROL_EVENT', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) {
            return;
        }

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room || !ALLOWED_CONTROL_TYPES.has(data?.type)) {
            return;
        }

        const relay = {
            sessionId,
            type: data.type,
            issuedAt: Date.now()
        };

        if (data.type === 'VIDEO_CHANGE') {
            const nextVideo = normalizeQueueItem(data);
            if (!nextVideo) {
                return;
            }
            room.currentVideo = nextVideo;
            relay.videoId = nextVideo.videoId;
            relay.title = nextVideo.title;
            relay.thumbnail = nextVideo.thumbnail;
            relay.time = 0;
        } else {
            const videoId = normalizeVideoId(data.videoId) || room.currentVideo?.videoId;
            if (!videoId) {
                return;
            }
            relay.videoId = videoId;
            relay.time = Number.isFinite(data.time) ? Math.max(0, data.time) : 0;
        }

        socket.to(sessionId).emit('CONTROL_EVENT', relay);
    });

    socket.on('FULL_SYNC_REPLY', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) {
            return;
        }

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room || socket.id !== room.hostSocketId) {
            return;
        }

        const videoId = normalizeVideoId(data?.videoId) || room.currentVideo?.videoId;
        if (!videoId) {
            return;
        }

        socket.to(sessionId).emit('FULL_SYNC', {
            sessionId,
            videoId,
            time: Number.isFinite(data?.time) ? Math.max(0, data.time) : 0,
            state: data?.state === 'PAUSE' ? 'PAUSE' : 'PLAY',
            issuedAt: Date.now()
        });
    });

    socket.on('SYNC_EVENT', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) {
            return;
        }

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room || socket.id !== room.hostSocketId) {
            return;
        }

        const videoId = normalizeVideoId(data?.videoId) || room.currentVideo?.videoId;
        if (!videoId) {
            return;
        }

        socket.to(sessionId).emit('SYNC_EVENT', {
            sessionId,
            videoId,
            time: Number.isFinite(data?.time) ? Math.max(0, data.time) : 0,
            state: data?.state === 'PAUSE' ? 'PAUSE' : 'PLAY',
            issuedAt: Date.now()
        });
    });

    socket.on('ADD_TO_QUEUE', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) {
            return;
        }

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) {
            return;
        }

        const videoItem = normalizeQueueItem(data?.videoItem);
        if (!videoItem) {
            return;
        }

        room.queue.push(videoItem);
        io.to(sessionId).emit('QUEUE_UPDATE', cloneQueue(room.queue));

        if (!room.currentVideo) {
            playNextInRoom(sessionId, room);
        }
    });

    socket.on('PLAY_NEXT', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) {
            return;
        }

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) {
            return;
        }

        playNextInRoom(sessionId, room);
    });

    socket.on('REMOVE_FROM_QUEUE', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) {
            return;
        }

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) {
            return;
        }

        const index = data?.index;
        if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) {
            return;
        }

        room.queue.splice(index, 1);
        io.to(sessionId).emit('QUEUE_UPDATE', cloneQueue(room.queue));
    });

    socket.on('REORDER_QUEUE', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) {
            return;
        }

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) {
            return;
        }

        const fromIndex = data?.fromIndex;
        const toIndex = data?.toIndex;
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
            return;
        }
        if (fromIndex < 0 || fromIndex >= room.queue.length || toIndex < 0 || toIndex >= room.queue.length) {
            return;
        }

        const [item] = room.queue.splice(fromIndex, 1);
        room.queue.splice(toIndex, 0, item);
        io.to(sessionId).emit('QUEUE_UPDATE', cloneQueue(room.queue));
    });

    socket.on('CHAT_MESSAGE', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) {
            return;
        }

        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) {
            return;
        }

        const message = clampString(data?.message, 200);
        if (!message) {
            return;
        }

        io.to(sessionId).emit('CHAT_MESSAGE', {
            userId: socket.id,
            userName: clampString(data?.userName, 20) || 'Anon',
            message,
            timestamp: Date.now()
        });
    });

    socket.on('disconnect', () => {
        const sessionId = normalizeSessionId(socket.data.sessionId);
        if (sessionId) {
            removeSocketFromRoom(socket, sessionId);
            socket.data.sessionId = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Ram Jam server running on http://localhost:${PORT}`);
});
