const express = require('express');
require('dotenv').config();
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const ytSearch = require('yt-search');
const {
    clampString,
    normalizeSessionId,
    normalizeVideoId,
    sanitizeThumbnail,
    normalizeQueueItem
} = require('./src/utils/session');

// Support both singular and plural env var names for convenience
const YOUTUBE_API_KEYS_RAW = process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEYS || '';
const YOUTUBE_API_KEYS = YOUTUBE_API_KEYS_RAW
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);

console.log(`[YouTube API] Detected ${YOUTUBE_API_KEYS.length} keys.`);

let currentYtKeyIndex = 0;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    transports: ['polling', 'websocket'],
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 20000
});

const ALLOWED_CONTROL_TYPES = new Set(['PLAY', 'PAUSE', 'SEEK', 'VIDEO_CHANGE']);

// Cache for YouTube search results to save quota
// Structure: Map<query, { results: any[], timestamp: number }>
const searchCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Increase to 24 hours for better saving
const CACHE_FILE = path.join(__dirname, 'search_cache.json');
const YT_MAPPING_FILE = path.join(__dirname, 'yt_mapping_cache.json');

// Memory cache for Spotify -> YouTube mapping
const ytCache = new Map();

// Load cache from file if it exists
try {
    const fs = require('fs');
    if (fs.existsSync(CACHE_FILE)) {
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        Object.entries(data).forEach(([key, val]) => {
            if (Date.now() - val.timestamp < CACHE_TTL_MS) {
                searchCache.set(key, val);
            }
        });
        console.log(`[Cache] Loaded ${searchCache.size} search entries.`);
    }

    if (fs.existsSync(YT_MAPPING_FILE)) {
        const mappingData = JSON.parse(fs.readFileSync(YT_MAPPING_FILE, 'utf8'));
        Object.entries(mappingData).forEach(([key, val]) => ytCache.set(key, val));
        console.log(`[Cache] Loaded ${ytCache.size} track mappings.`);
    }
} catch (err) {
    console.error('[Cache] Load failed:', err.message);
}

function saveCacheToFile() {
    try {
        const fs = require('fs');
        const searchData = Object.fromEntries(searchCache);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(searchData), 'utf8');
        
        const mappingData = Object.fromEntries(ytCache);
        fs.writeFileSync(YT_MAPPING_FILE, JSON.stringify(mappingData), 'utf8');
    } catch (err) {
        // no-op
    }
}

// Health check endpoint for Render.com
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/', (req, res) => {
    // If it's a health check (standard Render user agent), return 200 instead of redirecting
    const userAgent = req.headers['user-agent'] || '';
    if (userAgent.includes('Render/')) {
        res.status(200).send('OK');
        return;
    }
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

    // Force no-cache ONLY on index.html to ensure users get latest app updates
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
    index: false, // Don't serve index.html automatically (we handle it via /session/:id)
    maxAge: '1d', 
    etag: true
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

const rooms = new Map();

function createRoom(hostSocketId) {
    return {
        hostSocketId,
        users: new Set(),
        queue: [],
        history: [],
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

    if (room.currentVideo) {
        room.history.push(room.currentVideo);
        if (room.history.length > 50) room.history.shift();
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

function playPreviousInRoom(sessionId, room) {
    if (room.history.length === 0) {
        if (room.currentVideo) {
            io.to(sessionId).emit('CONTROL_EVENT', {
                sessionId,
                type: 'PLAY',
                videoId: room.currentVideo.videoId,
                time: 0,
                issuedAt: Date.now()
            });
        }
        return false;
    }

    const prevVideo = room.history.pop();
    if (room.currentVideo) {
        room.queue.unshift(room.currentVideo);
    }
    room.currentVideo = prevVideo;

    io.to(sessionId).emit('QUEUE_UPDATE', cloneQueue(room.queue));
    io.to(sessionId).emit('CONTROL_EVENT', {
        sessionId,
        type: 'VIDEO_CHANGE',
        videoId: prevVideo.videoId,
        title: prevVideo.title,
        thumbnail: prevVideo.thumbnail,
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

function extractYoutubeId(text) {
    if (!text) return null;
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
    const match = text.match(regex);
    if (match && match[1]) return match[1];
    
    // Check if it's already just a video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(text.trim())) return text.trim();
    
    return null;
}

async function youtubeGetVideoDetails(videoId) {
    if (YOUTUBE_API_KEYS.length === 0) return null;

    // Use current key
    const apiKey = YOUTUBE_API_KEYS[currentYtKeyIndex];
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;

    try {
        const resp = await fetch(url);
        const data = await resp.json();
        if (resp.ok && data.items?.[0]) {
            const item = data.items[0];
            return [{
                videoId: item.id,
                title: item.snippet?.title || '',
                thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
                author: item.snippet?.channelTitle || 'Unknown'
            }];
        }
    } catch (err) {
        console.error('[YouTube API] Detail fetch failed:', err.message);
    }
    return null;
}

async function youtubeSearch(query, maxResults = 1) {
    const cleanQuery = query.toLowerCase().trim();
    
    // QUOTA SAVER: If it's a URL, use the Detail endpoint (1 unit) instead of Search (100 units)
    const directId = extractYoutubeId(query);
    if (directId) {
        console.log(`[YouTube API] ID detected: ${directId}. Using 1-unit detail fetch.`);
        const details = await youtubeGetVideoDetails(directId);
        if (details) return details;
    }

    const cacheKey = `${cleanQuery}_${maxResults}`;
    const cached = searchCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
        console.log(`[YouTube API] Serving from cache: "${query}"`);
        return cached.results;
    }

    if (YOUTUBE_API_KEYS.length === 0) {
        return await executeYtSearch(query, maxResults);
    }

    const startIdx = currentYtKeyIndex;
    let triedCount = 0;

    while (triedCount < YOUTUBE_API_KEYS.length) {
        const apiKey = YOUTUBE_API_KEYS[currentYtKeyIndex];
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${apiKey}`;

        try {
            const resp = await fetch(url);
            const data = await resp.json();

            if (resp.ok) {
                const results = (data.items || []).map(item => ({
                    videoId: item.id?.videoId,
                    title: item.snippet?.title || '',
                    thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
                    author: item.snippet?.channelTitle || 'Unknown'
                }));

                // Save to cache
                searchCache.set(cacheKey, { results, timestamp: Date.now() });
                saveCacheToFile();
                return results;
            }

            // If key failed, log why and try the next one
            const errorReason = data.error?.errors?.[0]?.reason || 'unknown';
            console.warn(`[YouTube API] Key ${currentYtKeyIndex} failed (${resp.status}: ${errorReason}). Trying next key...`);
            
            currentYtKeyIndex = (currentYtKeyIndex + 1) % YOUTUBE_API_KEYS.length;
            triedCount++;
        } catch (err) {
            console.error(`[YouTube API] Key ${currentYtKeyIndex} fetch error:`, err.message);
            currentYtKeyIndex = (currentYtKeyIndex + 1) % YOUTUBE_API_KEYS.length;
            triedCount++;
        }
    }

    console.error('[YouTube API] All keys failed. Falling back to slow scraper.');
    return await executeYtSearch(query, maxResults);
}

// Helper to handle the yt-search scraping logic
async function executeYtSearch(query, maxResults) {
    try {
        const results = await ytSearch(query);
        const videos = results.videos.slice(0, maxResults);
        return videos.map(item => ({
            videoId: item.videoId,
            title: item.title,
            thumbnail: item.thumbnail,
            author: item.author?.name || 'Unknown'
        }));
    } catch (err) {
        console.error('yt-search failed:', err);
        return [];
    }
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
            saveCacheToFile();
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
        const results = await youtubeSearch(query, 10);
        res.json(results);
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
    } catch (error) {
        console.error('Resolve YouTube ID failed:', error);
        res.status(500).json({ error: 'Resolve failed' });
    }
});

io.on('connection', (socket) => {
    socket.on('JOIN_SESSION', (payload) => {
        const requestedSessionId = typeof payload === 'string' ? payload : payload?.sessionId;
        const sessionIdRaw = requestedSessionId || getSessionIdFromReferer(socket.handshake.headers?.referer);
        const sessionId = normalizeSessionId(sessionIdRaw);

        if (!sessionId) {
            console.warn(`[JOIN_ERROR] Invalid session id. Socket: ${socket.id}, Requested: "${requestedSessionId}", Referer: "${socket.handshake.headers?.referer}"`);
            socket.emit('JOIN_ERROR', { 
                message: 'Invalid session id',
                debug: { requested: requestedSessionId, hasReferer: !!socket.handshake.headers?.referer }
            });
            return;
        }

        console.log(`[JOIN_SUCCESS] Session: ${sessionId}, Socket: ${socket.id}`);

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
        if (!sessionId) return;
        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;
        playNextInRoom(sessionId, room);
    });

    socket.on('PLAY_PREVIOUS', (data) => {
        const sessionId = normalizeSessionId(data?.sessionId);
        if (!sessionId) return;
        const room = getJoinedRoom(sessionId, socket.id);
        if (!room) return;
        playPreviousInRoom(sessionId, room);
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
