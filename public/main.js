let socket;
let player;
let isHost = false;
let isPlayerReady = false;
let hasJoined = false;
let currentVideoId = null;
let syncInterval;
let seekBarInterval;
let suppressStateEventsUntil = 0;
let playbackHealthTimer;
let pendingResumeTime = 0;
let pendingResumeState = 'PLAY';

const HARD_SYNC_DRIFT_SECONDS = 0.4;
const PAUSED_SYNC_DRIFT_SECONDS = 0.15;

function extractSessionId() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'session' && parts[1]) return parts[1];
    return parts[parts.length - 1] || '';
}

const sessionId = extractSessionId();

// Elements
const roleBadge = document.getElementById('roleBadge');
const userCountEl = document.getElementById('userCount');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const skipBtn = document.getElementById('skipBtn');
const seekBar = document.getElementById('seekBar');
const currentTimeDisplay = document.getElementById('currentTimeDisplay');
const durationDisplay = document.getElementById('durationDisplay');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const queueList = document.getElementById('queueList');
const overlay = document.getElementById('overlay');
const joinOverlay = document.getElementById('joinOverlay');
const joinNameInput = document.getElementById('joinNameInput');
const joinBtn = document.getElementById('joinBtn');
const modalTitle = document.getElementById('modalTitle');
const modalMessage = document.getElementById('modalMessage');
const modalActionBtn = document.getElementById('modalActionBtn');

// Album Art Elements
const vinylRecord = document.getElementById('vinylRecord');
const albumArtImage = document.getElementById('albumArtImage');
const currentTrackTitle = document.getElementById('currentTrackTitle');

// Queue Data
let currentQueueMeta = [];

// Chat Elements
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
});

function suppressStateEvents(ms = 1200) {
    suppressStateEventsUntil = Math.max(suppressStateEventsUntil, Date.now() + ms);
}

function isStateEventSuppressed() {
    return Date.now() < suppressStateEventsUntil;
}

function getPlayerTime() {
    if (!player || !isPlayerReady) return 0;
    const t = player.getCurrentTime();
    return Number.isFinite(t) ? t : 0;
}

function getHostStateLabel() {
    if (!player || !isPlayerReady) return 'PAUSE';
    return player.getPlayerState() === YT.PlayerState.PLAYING ? 'PLAY' : 'PAUSE';
}

function hideModal() {
    overlay.classList.add('hidden');
    modalActionBtn.classList.add('hidden');
    modalActionBtn.onclick = null;
}

function showModal(title, msg, actionText, actionHandler) {
    modalTitle.innerText = title;
    modalMessage.innerText = msg;

    if (actionText && typeof actionHandler === 'function') {
        modalActionBtn.innerText = actionText;
        modalActionBtn.classList.remove('hidden');
        modalActionBtn.onclick = () => {
            actionHandler();
        };
    } else {
        modalActionBtn.classList.add('hidden');
        modalActionBtn.onclick = null;
    }

    overlay.classList.remove('hidden');
}

function setPlaybackControlsEnabled(enabled) {
    playBtn.disabled = !enabled;
    pauseBtn.disabled = !enabled;
    seekBar.disabled = !enabled;
}

function schedulePlaybackHealthCheck(expectedTime) {
    clearTimeout(playbackHealthTimer);
    let retries = 0;
    const maxRetries = 3;

    function attemptResume() {
        if (isHost || !isPlayerReady || !currentVideoId) return;
        if (player.getPlayerState() === YT.PlayerState.PLAYING) return;

        retries++;
        suppressStateEvents(1500);
        player.loadVideoById(currentVideoId, expectedTime || 0);
        player.playVideo();

        setTimeout(() => {
            if (player.getPlayerState() === YT.PlayerState.PLAYING) return;
            if (retries < maxRetries) {
                attemptResume(); // Try again
                return;
            }
            // All retries failed — show manual button as last resort
            pendingResumeTime = expectedTime;
            pendingResumeState = 'PLAY';
            showModal(
                'Tap to Play',
                'Tap below to start audio.',
                'Resume Audio',
                () => {
                    hideModal();
                    forceListenerPlayback(pendingResumeTime, pendingResumeState);
                }
            );
        }, 1500);
    }

    playbackHealthTimer = setTimeout(attemptResume, 2000);
}

function forceListenerPlayback(targetTime, state) {
    if (!isPlayerReady || !currentVideoId) return;

    const time = Number.isFinite(targetTime) ? targetTime : 0;
    suppressStateEvents(1500);

    if (state === 'PAUSE') {
        player.cueVideoById(currentVideoId, time);
        player.pauseVideo();

        return;
    }

    player.loadVideoById(currentVideoId, time);
    player.playVideo();

    schedulePlaybackHealthCheck(time);
}

function applySyncSnapshot(data) {
    if (isHost || !isPlayerReady || !data?.videoId) return;

    const latency = (Date.now() - data.issuedAt) / 1000;
    const expectedTime = Math.max(0, (data.time || 0) + latency);
    const state = data.state || 'PLAY';

    if (currentVideoId !== data.videoId) {
        currentVideoId = data.videoId;
        updateAlbumArt(currentVideoId);
        forceListenerPlayback(expectedTime, state);
        return;
    }

    const actualTime = getPlayerTime();
    const drift = Math.abs(expectedTime - actualTime);
    const playerState = player.getPlayerState();

    if (state === 'PAUSE') {
        if (drift > PAUSED_SYNC_DRIFT_SECONDS) {
            suppressStateEvents(900);
            player.seekTo(expectedTime, true);
        }
        if (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING) {
            suppressStateEvents(900);
            player.pauseVideo();
        }
        vinylRecord.style.animationPlayState = 'paused';
        return;
    }

    if (playerState === YT.PlayerState.BUFFERING) {
        return;
    }

    if (playerState !== YT.PlayerState.PLAYING) {
        forceListenerPlayback(expectedTime, 'PLAY');
        return;
    }

    if (drift > HARD_SYNC_DRIFT_SECONDS) {
        suppressStateEvents(900);
        player.seekTo(expectedTime, true);
    }
}

function emitControlEvent(type, overrides = {}) {
    if (!isPlayerReady || !currentVideoId) return;

    const data = {
        sessionId,
        type,
        time: Number.isFinite(overrides.time) ? overrides.time : getPlayerTime(),
        videoId: currentVideoId,
        title: overrides.title,
        thumbnail: overrides.thumbnail,
        issuedAt: Date.now()
    };
    socket.emit('CONTROL_EVENT', data);
}

function startHostSyncLoop() {
    clearInterval(syncInterval);
    syncInterval = setInterval(() => {
        if (!isHost || !isPlayerReady || !currentVideoId) return;
        socket.emit('SYNC_EVENT', {
            sessionId,
            videoId: currentVideoId,
            time: getPlayerTime(),
            state: getHostStateLabel(),
            issuedAt: Date.now()
        });
    }, 500);
}

function stopHostSyncLoop() {
    clearInterval(syncInterval);
    syncInterval = null;
}

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        playerVars: {
            autoplay: 0,
            controls: 1,
            disablekb: 1,
            rel: 0
        },
        events: {
            onReady: onPlayerReady,
            onStateChange: onPlayerStateChange
        }
    });
}

function onPlayerReady() {
    isPlayerReady = true;
    const savedName = localStorage.getItem('ramjam_username');
    if (savedName) joinNameInput.value = savedName;
}

function onPlayerStateChange(event) {
    if (isStateEventSuppressed()) return;

    if (event.data === YT.PlayerState.PLAYING) {

        emitControlEvent('PLAY');
        return;
    }

    if (event.data === YT.PlayerState.PAUSED) {

        emitControlEvent('PAUSE');
        return;
    }

    if (event.data === YT.PlayerState.ENDED) {
        vinylRecord.style.animationPlayState = 'paused';
        if (isHost) {
            setTimeout(() => {
                socket.emit('PLAY_NEXT', { sessionId });
            }, 400);
        }
    }
}

joinBtn.addEventListener('click', () => {
    if (hasJoined) return;

    let userName = joinNameInput.value.trim();
    if (!userName) userName = `User-${Math.floor(Math.random() * 1000)}`;
    localStorage.setItem('ramjam_username', userName);

    hasJoined = true;
    joinOverlay.classList.add('hidden');
    hideModal();

    // If YouTube player is ready, join immediately.
    // Otherwise, wait for it (mobile phones load the API slowly).
    function doJoin() {
        socket.emit('JOIN_SESSION', { sessionId, userName });
        if (!seekBarInterval) {
            seekBarInterval = setInterval(updateSeekBar, 1000);
        }
        startSilentKeepalive();
        requestWakeLock();
    }

    if (isPlayerReady) {
        doJoin();
    } else {
        // Poll until YouTube API is ready (check every 200ms, max 15s)
        let attempts = 0;
        const waitForPlayer = setInterval(() => {
            attempts++;
            if (isPlayerReady || attempts > 75) {
                clearInterval(waitForPlayer);
                doJoin();
            }
        }, 200);
    }
});

playBtn.addEventListener('click', () => {
    if (!isPlayerReady) return;
    player.playVideo();
});

pauseBtn.addEventListener('click', () => {
    if (!isPlayerReady) return;
    player.pauseVideo();
});

skipBtn.addEventListener('click', () => {
    if (!isPlayerReady || !currentVideoId) return;
    socket.emit('PLAY_NEXT', { sessionId });
});

seekBar.addEventListener('change', (e) => {
    if (!isPlayerReady || !currentVideoId || !isHost) return;

    const duration = player.getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return;

    const newTime = (e.target.value / 100) * duration;
    player.seekTo(newTime, true);
    emitControlEvent('SEEK', { time: newTime });
});

socket.on('connect', () => {
    if (hasJoined) {
        // Auto-rejoin after reconnect so the user never gets stuck on 'Connection Lost'
        const userName = localStorage.getItem('ramjam_username') || 'Anon';
        socket.emit('JOIN_SESSION', { sessionId, userName });
        hideModal();
    }
});

socket.on('disconnect', () => {
    showModal('Connection Lost', 'Reconnecting to session...');
});

socket.on('connect_error', () => {
    showModal('Network Error', 'Could not connect. Retrying...');
});

socket.on('JOIN_SUCCESS', (data) => {
    isHost = data.isHost;
    roleBadge.innerText = isHost ? 'HOST' : 'LISTENER';
    roleBadge.className = `badge role-badge ${isHost ? 'host' : 'listener'}`;
    userCountEl.innerText = data.userCount;
    setPlaybackControlsEnabled(true);
    hideModal();

    currentQueueMeta = data.queue || [];
    renderQueue(currentQueueMeta);

    if (data.currentVideo) {
        currentVideoId = typeof data.currentVideo === 'object' ? data.currentVideo.videoId : data.currentVideo;
        if (typeof data.currentVideo === 'object') {
            currentQueueMeta.push(data.currentVideo);
        }
        updateAlbumArt(currentVideoId);
    }

    if (isHost) {
        startHostSyncLoop();
    } else {
        stopHostSyncLoop();
    }
});

socket.on('JOIN_ERROR', (data) => {
    hasJoined = false;
    joinOverlay.classList.remove('hidden');
    showModal('Join Failed', data?.message || 'Could not join this session.');
});

socket.on('SESSION_FULL', () => {
    showModal('Session Full', 'This Jam Session already has 2 users.');
});

socket.on('USER_JOINED', (data) => {
    userCountEl.innerText = data.userCount;
});

socket.on('USER_LEFT', (data) => {
    userCountEl.innerText = data.userCount;
});

socket.on('SESSION_ENDED', () => {
    stopHostSyncLoop();
    clearTimeout(playbackHealthTimer);
    if (player) player.pauseVideo();
    vinylRecord.style.animationPlayState = 'paused';
    showModal('Session Ended', 'The host has left the session.');
});

socket.on('CONTROL_EVENT', (data) => {
    if (!isPlayerReady || !data) return;

    const latency = (Date.now() - data.issuedAt) / 1000;
    const expectedTime = Math.max(0, (data.time || 0) + latency);

    // VIDEO_CHANGE must be handled by ALL clients, including the host
    if (data.type === 'VIDEO_CHANGE') {
        currentVideoId = data.videoId;
        currentQueueMeta.push({
            videoId: data.videoId,
            title: data.title || `Track ${data.videoId}`,
            thumbnail: data.thumbnail || `https://img.youtube.com/vi/${data.videoId}/hqdefault.jpg`
        });
        updateAlbumArt(currentVideoId);

        // Both host and listener load and play the new video
        suppressStateEvents(1500);
        player.loadVideoById(currentVideoId, 0);
        player.playVideo();
        vinylRecord.style.animationPlayState = 'running';

        if (!isHost) {
            schedulePlaybackHealthCheck(0);
        }
        return;
    }

    // All other control events: allow PLAY/PAUSE for everyone, SEEK host-only
    if (isHost && data.type === 'SEEK') return;

    if (!currentVideoId || data.videoId !== currentVideoId) return;

    if (data.type === 'PLAY') {
        suppressStateEvents(1200);
        player.seekTo(expectedTime, true);
        player.playVideo();
        vinylRecord.style.animationPlayState = 'running';
        schedulePlaybackHealthCheck(expectedTime);
        return;
    }

    if (data.type === 'PAUSE') {
        suppressStateEvents(900);
        player.pauseVideo();
        player.seekTo(expectedTime, true);
        vinylRecord.style.animationPlayState = 'paused';
        return;
    }

    if (data.type === 'SEEK') {
        suppressStateEvents(900);
        player.seekTo(expectedTime, true);
    }
});

socket.on('SYNC_EVENT', (data) => {
    if (!isPlayerReady || isHost) return;
    applySyncSnapshot(data);
});

socket.on('REQUEST_FULL_SYNC', () => {
    if (!isHost || !isPlayerReady || !currentVideoId) return;
    socket.emit('FULL_SYNC_REPLY', {
        sessionId,
        videoId: currentVideoId,
        time: getPlayerTime(),
        state: getHostStateLabel(),
        issuedAt: Date.now()
    });
});

socket.on('FULL_SYNC', (data) => {
    if (!isPlayerReady || isHost || !data?.videoId) return;
    currentVideoId = data.videoId;
    updateAlbumArt(currentVideoId);
    applySyncSnapshot(data);
});

socket.on('QUEUE_UPDATE', (queue) => {
    currentQueueMeta = queue || [];
    renderQueue(currentQueueMeta);
});

let searchTimeout;
searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();

    if (query.length < 3) {
        searchResults.classList.add('hidden');
        return;
    }

    searchTimeout = setTimeout(() => {
        fetch(`/api/search?q=${encodeURIComponent(query)}`)
            .then((res) => res.json())
            .then((data) => {
                renderSearchResults(data);
            })
            .catch((err) => console.error(err));
    }, 350);
});

function renderSearchResults(results) {
    searchResults.innerHTML = '';

    if (!results || results.length === 0) {
        searchResults.innerHTML = '<div style="padding: 10px; color: white;">No results found</div>';
        searchResults.classList.remove('hidden');
        return;
    }

    searchResults.classList.remove('hidden');

    results.forEach((video) => {
        const div = document.createElement('div');
        div.className = 'search-result-item';
        const durationStr = video.duration ? `${Math.floor(video.duration / 60)}:${String(video.duration % 60).padStart(2, '0')}` : '';
        const sourceIcon = video.source === 'spotify' ? '🟢' : '▶️';
        div.innerHTML = `
            <img src="${video.thumbnail}" alt="thumb">
            <div class="search-result-info">
                <span class="search-result-title">${sourceIcon} ${video.title}</span>
                <span class="search-result-author">${video.author}${video.album ? ' · ' + video.album : ''}${durationStr ? ' · ' + durationStr : ''}</span>
            </div>
        `;

        div.addEventListener('click', async () => {
            searchInput.value = '';
            searchResults.innerHTML = '';
            searchResults.classList.add('hidden');

            let videoId = video.videoId;

            // Spotify results: resolve YouTube ID on click (cached server-side)
            if (video.source === 'spotify' && !videoId) {
                try {
                    const resp = await fetch(`/api/resolve-yt?artist=${encodeURIComponent(video.artist)}&track=${encodeURIComponent(video.trackName)}`);
                    const data = await resp.json();
                    videoId = data.videoId;
                } catch (e) {
                    console.error('Failed to resolve YouTube video:', e);
                    return;
                }
            }

            if (!videoId) return;

            const videoItem = {
                id: Date.now().toString(),
                videoId,
                title: video.title,
                thumbnail: video.thumbnail
            };

            socket.emit('ADD_TO_QUEUE', { sessionId, videoItem });

            // Auto-play: if nothing is playing, tell server to start the next song.
            if (!currentVideoId) {
                setTimeout(() => {
                    socket.emit('PLAY_NEXT', { sessionId });
                }, 500);
            }
        });

        searchResults.appendChild(div);
    });
}

function updateSeekBar() {
    if (!isPlayerReady || !player || !currentVideoId) return;

    const current = getPlayerTime();
    const duration = player.getDuration() || 0;

    if (duration > 0) {
        seekBar.value = (current / duration) * 100;
    }

    currentTimeDisplay.innerText = formatTime(current);
    durationDisplay.innerText = formatTime(duration);
}

function formatTime(seconds) {
    if (!seconds || Number.isNaN(seconds)) return '0:00';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function updateAlbumArt(videoId) {
    const item = currentQueueMeta.find((q) => q.videoId === videoId);
    if (item) {
        albumArtImage.src = item.thumbnail;
        currentTrackTitle.innerText = item.title;
        updateMediaSession(item.title, item.thumbnail);
        return;
    }

    albumArtImage.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    currentTrackTitle.innerText = `Track ${videoId}`;
    updateMediaSession(`Track ${videoId}`, `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`);
}

function renderQueue(queue) {
    queueList.innerHTML = '';
    if (!queue || queue.length === 0) {
        queueList.innerHTML = '<li class="empty-queue">Queue is empty</li>';
        return;
    }

    queue.forEach((item, index) => {
        const li = document.createElement('li');
        li.className = 'queue-item';
        li.draggable = true;
        li.dataset.index = index;
        li.innerHTML = `
            <span class="drag-handle">☰</span>
            <img src="${item.thumbnail}" alt="thumbnail">
            <div class="queue-item-details">
                <span class="queue-item-title">${item.title}</span>
            </div>
            <button class="queue-delete-btn" title="Remove">✕</button>
        `;

        // Delete button
        li.querySelector('.queue-delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            socket.emit('REMOVE_FROM_QUEUE', { sessionId, index });
        });

        // Drag-and-drop reorder
        li.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', index);
            li.classList.add('dragging');
        });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', (e) => e.preventDefault());
        li.addEventListener('drop', (e) => {
            e.preventDefault();
            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
            const toIndex = parseInt(li.dataset.index);
            if (fromIndex !== toIndex) {
                socket.emit('REORDER_QUEUE', { sessionId, fromIndex, toIndex });
            }
        });

        queueList.appendChild(li);
    });
}

copyLinkBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    const origText = copyLinkBtn.innerText;
    copyLinkBtn.innerText = 'Copied!';
    setTimeout(() => {
        copyLinkBtn.innerText = origText;
    }, 1500);
});

// ─── CHAT ───────────────────────────────────────────────────
function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message || !hasJoined) return;
    socket.emit('CHAT_MESSAGE', {
        sessionId,
        userName: localStorage.getItem('ramjam_username') || 'Anon',
        message
    });
    chatInput.value = '';
}

chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

socket.on('CHAT_MESSAGE', (data) => {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const isMe = data.userId === socket.id;
    const name = document.createElement('span');
    name.className = `chat-user ${isMe ? 'chat-me' : ''}`;
    name.textContent = data.userName + ': ';
    div.appendChild(name);
    div.appendChild(document.createTextNode(data.message));
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// ─── MOBILE BACKGROUND PLAY ────────────────────────────────
// Media Session API — lock-screen controls
function updateMediaSession(title, artwork) {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title || 'Ram Jam',
            artist: 'Ram Jam Session',
            artwork: artwork ? [{ src: artwork, sizes: '512x512', type: 'image/jpeg' }] : []
        });
        navigator.mediaSession.setActionHandler('play', () => { player.playVideo(); });
        navigator.mediaSession.setActionHandler('pause', () => { player.pauseVideo(); });
        navigator.mediaSession.setActionHandler('nexttrack', () => { socket.emit('PLAY_NEXT', { sessionId }); });
    } catch (e) { /* some browsers don't support all handlers */ }
}

// Screen Wake Lock — prevent screen from sleeping during playback
let wakeLock = null;
async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* wake lock not available */ }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isPlayerReady && currentVideoId) {
        requestWakeLock();
    }
});

// Silent audio keepalive — keeps audio session alive when tab is backgrounded
function startSilentKeepalive() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
    } catch (e) { /* silent keepalive not supported */ }
}
