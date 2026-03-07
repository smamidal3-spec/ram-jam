let socket;
let player;
let isHost = false;
let isPlayerReady = false;
let hasJoined = false;
let pendingJoin = false;
let currentVideoId = null;
let currentTrackMeta = null;
let syncInterval;
let seekBarInterval;
let suppressStateEventsUntil = 0;
let playbackHealthTimer;
let pendingResumeTime = 0;
let pendingResumeState = 'PLAY';
let searchTimeout;
let activeSearchController = null;
let searchRequestId = 0;

const HARD_SYNC_DRIFT_SECONDS = 0.4;
const PAUSED_SYNC_DRIFT_SECONDS = 0.15;
const PLAYER_READY_WAIT_MS = 15000;

function extractSessionId() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'session' && parts[1]) {
        return parts[1].toUpperCase();
    }
    return '';
}

const sessionId = extractSessionId();

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
const vinylRecord = document.getElementById('vinylRecord');
const albumArtImage = document.getElementById('albumArtImage');
const currentTrackTitle = document.getElementById('currentTrackTitle');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

let currentQueueMeta = [];

setPlaybackControlsEnabled(false);

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
    if (!player || !isPlayerReady) {
        return 0;
    }
    const value = player.getCurrentTime();
    return Number.isFinite(value) ? value : 0;
}

function getHostStateLabel() {
    if (!player || !isPlayerReady) {
        return 'PAUSE';
    }
    return player.getPlayerState() === YT.PlayerState.PLAYING ? 'PLAY' : 'PAUSE';
}

function hideModal() {
    overlay.classList.add('hidden');
    modalActionBtn.classList.add('hidden');
    modalActionBtn.onclick = null;
}

function showModal(title, message, actionText, actionHandler) {
    modalTitle.innerText = title;
    modalMessage.innerText = message;

    if (actionText && typeof actionHandler === 'function') {
        modalActionBtn.innerText = actionText;
        modalActionBtn.classList.remove('hidden');
        modalActionBtn.onclick = () => actionHandler();
    } else {
        modalActionBtn.classList.add('hidden');
        modalActionBtn.onclick = null;
    }

    overlay.classList.remove('hidden');
}

function setPlaybackControlsEnabled(enabled) {
    playBtn.disabled = !enabled;
    pauseBtn.disabled = !enabled;
    skipBtn.disabled = !enabled;
    seekBar.disabled = !enabled;
}

function sanitizeText(value, fallback = '', max = 140) {
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim().replace(/[\u0000-\u001F\u007F]/g, '');
    return trimmed ? trimmed.slice(0, max) : fallback;
}

function sanitizeImageUrl(value, videoId) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^https?:\/\//i.test(trimmed)) {
            return trimmed;
        }
    }
    if (videoId) {
        return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }
    return 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
}

function schedulePlaybackHealthCheck(expectedTime) {
    clearTimeout(playbackHealthTimer);

    let retries = 0;
    const maxRetries = 3;

    function attemptResume() {
        if (isHost || !isPlayerReady || !currentVideoId) {
            return;
        }
        if (player.getPlayerState() === YT.PlayerState.PLAYING) {
            return;
        }

        retries += 1;
        suppressStateEvents(1500);
        player.loadVideoById(currentVideoId, expectedTime || 0);
        player.playVideo();

        setTimeout(() => {
            if (player.getPlayerState() === YT.PlayerState.PLAYING) {
                return;
            }
            if (retries < maxRetries) {
                attemptResume();
                return;
            }

            pendingResumeTime = expectedTime;
            pendingResumeState = 'PLAY';
            showModal('Tap to Play', 'Tap below to start audio.', 'Resume Audio', () => {
                hideModal();
                forceListenerPlayback(pendingResumeTime, pendingResumeState);
            });
        }, 1500);
    }

    playbackHealthTimer = setTimeout(attemptResume, 2000);
}

function forceListenerPlayback(targetTime, state) {
    if (!isPlayerReady || !currentVideoId) {
        return;
    }

    const seekTime = Number.isFinite(targetTime) ? targetTime : 0;
    suppressStateEvents(1500);

    if (state === 'PAUSE') {
        player.cueVideoById(currentVideoId, seekTime);
        player.pauseVideo();
        vinylRecord.style.animationPlayState = 'paused';
        return;
    }

    player.loadVideoById(currentVideoId, seekTime);
    player.playVideo();
    vinylRecord.style.animationPlayState = 'running';
    schedulePlaybackHealthCheck(seekTime);
}

function applySyncSnapshot(data) {
    if (isHost || !isPlayerReady || !data?.videoId) {
        return;
    }

    const issuedAt = Number.isFinite(data.issuedAt) ? data.issuedAt : Date.now();
    const latency = Math.max(0, (Date.now() - issuedAt) / 1000);
    const expectedTime = Math.max(0, (Number.isFinite(data.time) ? data.time : 0) + latency);
    const state = data.state === 'PAUSE' ? 'PAUSE' : 'PLAY';

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
    if (!isHost || !isPlayerReady || !currentVideoId) {
        return;
    }

    socket.emit('CONTROL_EVENT', {
        sessionId,
        type,
        time: Number.isFinite(overrides.time) ? overrides.time : getPlayerTime(),
        videoId: currentVideoId,
        title: overrides.title,
        thumbnail: overrides.thumbnail,
        issuedAt: Date.now()
    });
}

function startHostSyncLoop() {
    clearInterval(syncInterval);
    syncInterval = setInterval(() => {
        if (!isHost || !isPlayerReady || !currentVideoId) {
            return;
        }

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

function waitForPlayerReady(timeoutMs = PLAYER_READY_WAIT_MS) {
    if (isPlayerReady) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (isPlayerReady) {
                clearInterval(timer);
                resolve();
                return;
            }

            if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                reject(new Error('player_ready_timeout'));
            }
        }, 200);
    });
}

function getOrCreateUserName() {
    const existing = localStorage.getItem('ramjam_username');
    if (existing && existing.trim()) {
        return existing.trim().slice(0, 20);
    }

    let entered = joinNameInput.value.trim();
    if (!entered) {
        entered = `User-${Math.floor(Math.random() * 1000)}`;
    }
    entered = entered.slice(0, 20);
    localStorage.setItem('ramjam_username', entered);
    return entered;
}

function setJoinPendingUI(pending) {
    pendingJoin = pending;
    joinBtn.disabled = pending;
    joinBtn.innerText = pending ? 'Joining...' : 'Enter Session';
}

async function submitJoin() {
    if (hasJoined || pendingJoin) {
        return;
    }

    const userName = getOrCreateUserName();
    joinNameInput.value = userName;
    setJoinPendingUI(true);

    try {
        await waitForPlayerReady();
        hideModal();
        socket.emit('JOIN_SESSION', { sessionId, userName });
    } catch {
        setJoinPendingUI(false);
        showModal('Player Load Failed', 'Could not initialize audio player. Reload and try again.');
    }
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

window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function onPlayerReady() {
    isPlayerReady = true;
    const savedName = localStorage.getItem('ramjam_username');
    if (savedName) {
        joinNameInput.value = savedName;
    }

    if (pendingJoin && !hasJoined) {
        const userName = getOrCreateUserName();
        socket.emit('JOIN_SESSION', { sessionId, userName });
    }
}

function onPlayerStateChange(event) {
    if (!isHost || isStateEventSuppressed()) {
        return;
    }

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
        socket.emit('PLAY_NEXT', { sessionId });
    }
}

joinBtn.addEventListener('click', () => {
    submitJoin();
});

playBtn.addEventListener('click', () => {
    if (!isHost || !isPlayerReady || !currentVideoId) {
        return;
    }
    player.playVideo();
});

pauseBtn.addEventListener('click', () => {
    if (!isHost || !isPlayerReady || !currentVideoId) {
        return;
    }
    player.pauseVideo();
});

skipBtn.addEventListener('click', () => {
    if (!isHost || !isPlayerReady || !currentVideoId) {
        return;
    }
    socket.emit('PLAY_NEXT', { sessionId });
});

seekBar.addEventListener('change', (event) => {
    if (!isHost || !isPlayerReady || !currentVideoId) {
        return;
    }

    const duration = player.getDuration();
    if (!Number.isFinite(duration) || duration <= 0) {
        return;
    }

    const newTime = (event.target.value / 100) * duration;
    player.seekTo(newTime, true);
    emitControlEvent('SEEK', { time: newTime });
});

socket.on('connect', () => {
    if (hasJoined) {
        const userName = localStorage.getItem('ramjam_username') || 'Anon';
        socket.emit('JOIN_SESSION', { sessionId, userName });
        hideModal();
    }
});

socket.on('disconnect', () => {
    if (hasJoined) {
        showModal('Connection Lost', 'Reconnecting to session...');
    }
});

socket.on('connect_error', () => {
    showModal('Network Error', 'Could not connect. Retrying...');
});

socket.on('JOIN_SUCCESS', (data) => {
    hasJoined = true;
    setJoinPendingUI(false);
    hideModal();
    joinOverlay.classList.add('hidden');

    isHost = !!data.isHost;
    roleBadge.innerText = isHost ? 'HOST' : 'LISTENER';
    roleBadge.className = `badge role-badge ${isHost ? 'host' : 'listener'}`;
    userCountEl.innerText = String(data.userCount || 0);
    setPlaybackControlsEnabled(isHost);

    currentQueueMeta = Array.isArray(data.queue) ? data.queue : [];
    renderQueue(currentQueueMeta);

    if (data.currentVideo) {
        if (typeof data.currentVideo === 'object') {
            currentVideoId = data.currentVideo.videoId || null;
            currentTrackMeta = {
                videoId: currentVideoId,
                title: sanitizeText(data.currentVideo.title, currentVideoId ? `Track ${currentVideoId}` : 'Ready to Jam'),
                thumbnail: sanitizeImageUrl(data.currentVideo.thumbnail, currentVideoId)
            };
        } else if (typeof data.currentVideo === 'string') {
            currentVideoId = data.currentVideo;
            currentTrackMeta = {
                videoId: currentVideoId,
                title: `Track ${currentVideoId}`,
                thumbnail: sanitizeImageUrl('', currentVideoId)
            };
        }
        if (currentVideoId) {
            updateAlbumArt(currentVideoId, currentTrackMeta);
        }
    }

    if (isHost) {
        startHostSyncLoop();
    } else {
        stopHostSyncLoop();
    }

    if (!seekBarInterval) {
        seekBarInterval = setInterval(updateSeekBar, 1000);
    }

    startSilentKeepalive();
    requestWakeLock();
});

socket.on('JOIN_ERROR', (data) => {
    hasJoined = false;
    setJoinPendingUI(false);
    joinOverlay.classList.remove('hidden');
    showModal('Join Failed', data?.message || 'Could not join this session.');
});

socket.on('SESSION_FULL', () => {
    hasJoined = false;
    setJoinPendingUI(false);
    joinOverlay.classList.remove('hidden');
    showModal('Session Full', 'This Jam Session already has 2 users.');
});

socket.on('USER_JOINED', (data) => {
    userCountEl.innerText = String(data.userCount || 0);
});

socket.on('USER_LEFT', (data) => {
    userCountEl.innerText = String(data.userCount || 0);
});

socket.on('SESSION_ENDED', () => {
    hasJoined = false;
    setJoinPendingUI(false);
    stopHostSyncLoop();
    clearTimeout(playbackHealthTimer);

    if (player && isPlayerReady) {
        player.pauseVideo();
    }
    vinylRecord.style.animationPlayState = 'paused';
    setPlaybackControlsEnabled(false);
    joinOverlay.classList.remove('hidden');

    showModal('Session Ended', 'The host left. Join again to start a new session.');
});

socket.on('CONTROL_EVENT', (data) => {
    if (!isPlayerReady || !data) {
        return;
    }

    const issuedAt = Number.isFinite(data.issuedAt) ? data.issuedAt : Date.now();
    const latency = Math.max(0, (Date.now() - issuedAt) / 1000);
    const expectedTime = Math.max(0, (Number.isFinite(data.time) ? data.time : 0) + latency);

    if (data.type === 'VIDEO_CHANGE') {
        if (!data.videoId) {
            return;
        }

        currentVideoId = data.videoId;
        currentTrackMeta = {
            videoId: data.videoId,
            title: sanitizeText(data.title, `Track ${data.videoId}`),
            thumbnail: sanitizeImageUrl(data.thumbnail, data.videoId)
        };
        updateAlbumArt(currentVideoId, currentTrackMeta);

        suppressStateEvents(1500);
        player.loadVideoById(currentVideoId, 0);
        player.playVideo();
        vinylRecord.style.animationPlayState = 'running';

        if (!isHost) {
            schedulePlaybackHealthCheck(0);
        }
        return;
    }

    if (!currentVideoId || data.videoId !== currentVideoId) {
        return;
    }

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
    if (!isPlayerReady || isHost) {
        return;
    }
    applySyncSnapshot(data);
});

socket.on('REQUEST_FULL_SYNC', () => {
    if (!isHost || !isPlayerReady || !currentVideoId) {
        return;
    }

    socket.emit('FULL_SYNC_REPLY', {
        sessionId,
        videoId: currentVideoId,
        time: getPlayerTime(),
        state: getHostStateLabel(),
        issuedAt: Date.now()
    });
});

socket.on('FULL_SYNC', (data) => {
    if (!isPlayerReady || isHost || !data?.videoId) {
        return;
    }

    currentVideoId = data.videoId;
    updateAlbumArt(currentVideoId);
    applySyncSnapshot(data);
});

socket.on('QUEUE_UPDATE', (queue) => {
    currentQueueMeta = Array.isArray(queue) ? queue : [];
    renderQueue(currentQueueMeta);
});

function clearSearchResults() {
    searchResults.innerHTML = '';
    searchResults.classList.add('hidden');
}

function showSearchMessage(message) {
    searchResults.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'search-result-item';
    row.style.cursor = 'default';

    const text = document.createElement('div');
    text.className = 'search-result-info';
    const title = document.createElement('span');
    title.className = 'search-result-title';
    title.textContent = message;
    text.appendChild(title);
    row.appendChild(text);

    searchResults.appendChild(row);
    searchResults.classList.remove('hidden');
}

function resultBadge(source) {
    if (source === 'spotify') {
        return '[SP]';
    }
    return '[YT]';
}

async function queueSearchResult(video) {
    searchInput.value = '';
    clearSearchResults();

    let videoId = video.videoId;

    if (video.source === 'spotify' && !videoId) {
        try {
            const response = await fetch(`/api/resolve-yt?artist=${encodeURIComponent(video.artist || '')}&track=${encodeURIComponent(video.trackName || '')}`);
            if (!response.ok) {
                throw new Error('resolve_failed');
            }
            const data = await response.json();
            videoId = data.videoId;
        } catch {
            showModal('Track Unavailable', 'Could not map this track to YouTube. Try another result.');
            return;
        }
    }

    if (!videoId) {
        showModal('Track Unavailable', 'No playable source found for this track.');
        return;
    }

    socket.emit('ADD_TO_QUEUE', {
        sessionId,
        videoItem: {
            videoId,
            title: sanitizeText(video.title, `Track ${videoId}`),
            thumbnail: sanitizeImageUrl(video.thumbnail, videoId)
        }
    });
}

function renderSearchResults(results) {
    searchResults.innerHTML = '';

    if (!Array.isArray(results) || results.length === 0) {
        showSearchMessage('No results found');
        return;
    }

    searchResults.classList.remove('hidden');

    results.forEach((video) => {
        const row = document.createElement('div');
        row.className = 'search-result-item';

        const image = document.createElement('img');
        image.src = sanitizeImageUrl(video.thumbnail, video.videoId);
        image.alt = 'thumbnail';

        const info = document.createElement('div');
        info.className = 'search-result-info';

        const title = document.createElement('span');
        title.className = 'search-result-title';
        title.textContent = `${resultBadge(video.source)} ${sanitizeText(video.title, 'Untitled')}`;

        const author = document.createElement('span');
        author.className = 'search-result-author';

        const metaParts = [];
        if (video.author) {
            metaParts.push(sanitizeText(video.author, 'Unknown', 80));
        }
        if (video.album) {
            metaParts.push(sanitizeText(video.album, '', 80));
        }
        if (Number.isFinite(video.duration) && video.duration > 0) {
            metaParts.push(formatTime(video.duration));
        }
        author.textContent = metaParts.join(' | ');

        info.appendChild(title);
        info.appendChild(author);

        row.appendChild(image);
        row.appendChild(info);

        row.addEventListener('click', () => {
            queueSearchResult(video);
        });

        searchResults.appendChild(row);
    });
}

searchInput.addEventListener('input', (event) => {
    clearTimeout(searchTimeout);

    const query = event.target.value.trim();
    if (query.length < 2) {
        if (activeSearchController) {
            activeSearchController.abort();
            activeSearchController = null;
        }
        clearSearchResults();
        return;
    }

    searchTimeout = setTimeout(async () => {
        if (activeSearchController) {
            activeSearchController.abort();
        }

        const requestId = ++searchRequestId;
        activeSearchController = new AbortController();
        showSearchMessage('Searching...');

        try {
            const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
                signal: activeSearchController.signal
            });

            if (!response.ok) {
                throw new Error(`search_http_${response.status}`);
            }

            const data = await response.json();
            if (requestId !== searchRequestId) {
                return;
            }
            renderSearchResults(data);
        } catch (err) {
            if (err?.name === 'AbortError') {
                return;
            }
            if (requestId !== searchRequestId) {
                return;
            }
            showSearchMessage('Search failed. Check connection and retry.');
        }
    }, 300);
});

function updateSeekBar() {
    if (!isPlayerReady || !player || !currentVideoId) {
        return;
    }

    const current = getPlayerTime();
    const duration = player.getDuration() || 0;

    if (duration > 0) {
        seekBar.value = (current / duration) * 100;
    }

    currentTimeDisplay.innerText = formatTime(current);
    durationDisplay.innerText = formatTime(duration);
}

function formatTime(seconds) {
    if (!seconds || Number.isNaN(seconds)) {
        return '0:00';
    }
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function updateAlbumArt(videoId, overrideMeta = null) {
    if (!videoId) {
        currentTrackTitle.innerText = 'Ready to Jam';
        return;
    }

    const queueItem = currentQueueMeta.find((item) => item.videoId === videoId);
    const source = overrideMeta || currentTrackMeta || queueItem;

    const title = sanitizeText(source?.title, `Track ${videoId}`);
    const thumbnail = sanitizeImageUrl(source?.thumbnail, videoId);

    currentTrackMeta = { videoId, title, thumbnail };
    albumArtImage.src = thumbnail;
    currentTrackTitle.innerText = title;
    updateMediaSession(title, thumbnail);
}

function renderQueue(queue) {
    queueList.innerHTML = '';

    if (!Array.isArray(queue) || queue.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty-queue';
        empty.textContent = 'Queue is empty';
        queueList.appendChild(empty);
        return;
    }

    queue.forEach((item, index) => {
        const li = document.createElement('li');
        li.className = 'queue-item';
        li.dataset.index = String(index);
        li.draggable = isHost;

        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.textContent = '::';

        const image = document.createElement('img');
        image.src = sanitizeImageUrl(item.thumbnail, item.videoId);
        image.alt = 'thumbnail';

        const details = document.createElement('div');
        details.className = 'queue-item-details';

        const title = document.createElement('span');
        title.className = 'queue-item-title';
        title.textContent = sanitizeText(item.title, `Track ${item.videoId}`);
        details.appendChild(title);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'queue-delete-btn';
        removeBtn.title = 'Remove';
        removeBtn.type = 'button';
        removeBtn.textContent = 'x';
        removeBtn.style.display = isHost ? 'inline-block' : 'none';

        removeBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!isHost) {
                return;
            }
            socket.emit('REMOVE_FROM_QUEUE', { sessionId, index });
        });

        li.appendChild(handle);
        li.appendChild(image);
        li.appendChild(details);
        li.appendChild(removeBtn);

        if (isHost) {
            li.addEventListener('dragstart', (event) => {
                event.dataTransfer.setData('text/plain', String(index));
                li.classList.add('dragging');
            });
            li.addEventListener('dragend', () => {
                li.classList.remove('dragging');
            });
            li.addEventListener('dragover', (event) => {
                event.preventDefault();
            });
            li.addEventListener('drop', (event) => {
                event.preventDefault();
                const fromIndex = parseInt(event.dataTransfer.getData('text/plain'), 10);
                const toIndex = parseInt(li.dataset.index, 10);
                if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) {
                    return;
                }
                socket.emit('REORDER_QUEUE', { sessionId, fromIndex, toIndex });
            });
        }

        queueList.appendChild(li);
    });
}

copyLinkBtn.addEventListener('click', async () => {
    try {
        if (!navigator.clipboard?.writeText) {
            return;
        }
        await navigator.clipboard.writeText(window.location.href);
        copyLinkBtn.style.color = '#6ee7b7';
        setTimeout(() => {
            copyLinkBtn.style.color = '';
        }, 1500);
    } catch {
        showModal('Copy Failed', 'Could not copy invite link on this browser.');
    }
});

function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message || !hasJoined) {
        return;
    }

    socket.emit('CHAT_MESSAGE', {
        sessionId,
        userName: (localStorage.getItem('ramjam_username') || 'Anon').slice(0, 20),
        message
    });
    chatInput.value = '';
}

chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        sendChatMessage();
    }
});

socket.on('CHAT_MESSAGE', (data) => {
    const wrapper = document.createElement('div');
    const isSelf = data.userId === socket.id;
    wrapper.className = `chat-msg${isSelf ? ' self' : ''}`;

    const sender = document.createElement('span');
    sender.className = 'chat-sender';
    sender.textContent = sanitizeText(data.userName, 'Anon', 20);

    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = sanitizeText(data.message, '', 200);

    wrapper.appendChild(sender);
    wrapper.appendChild(text);
    chatMessages.appendChild(wrapper);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

function updateMediaSession(title, artwork) {
    if (!('mediaSession' in navigator)) {
        return;
    }

    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title || "Ram's Jam",
            artist: "Ram's Jam Session",
            artwork: artwork ? [{ src: artwork, sizes: '512x512', type: 'image/jpeg' }] : []
        });

        navigator.mediaSession.setActionHandler('play', () => {
            if (isHost && currentVideoId) {
                player.playVideo();
            }
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (isHost && currentVideoId) {
                player.pauseVideo();
            }
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            if (isHost) {
                socket.emit('PLAY_NEXT', { sessionId });
            }
        });
    } catch {
        // no-op
    }
}

let wakeLock = null;

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
        return;
    }

    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
        });
    } catch {
        // no-op
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isPlayerReady && currentVideoId) {
        requestWakeLock();
    }
});

function startSilentKeepalive() {
    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = context.createOscillator();
        const gain = context.createGain();

        gain.gain.value = 0.001;
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
    } catch {
        // no-op
    }
}
