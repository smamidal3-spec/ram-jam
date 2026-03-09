const SESSION_ID_PATTERN = /^[A-Z0-9]{4,16}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;

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

module.exports = {
    clampString,
    normalizeSessionId,
    normalizeVideoId,
    sanitizeThumbnail,
    normalizeQueueItem
};
