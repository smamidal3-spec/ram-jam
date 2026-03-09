const test = require('node:test');
const assert = require('node:assert/strict');
const {
    clampString,
    normalizeSessionId,
    normalizeVideoId,
    sanitizeThumbnail,
    normalizeQueueItem
} = require('../src/utils/session');

test('normalizeSessionId uppercases valid input', () => {
    assert.equal(normalizeSessionId('ab12cd'), 'AB12CD');
});

test('normalizeSessionId rejects invalid input', () => {
    assert.equal(normalizeSessionId('abc-123'), null);
    assert.equal(normalizeSessionId(''), null);
});

test('normalizeVideoId validates safe YouTube id format', () => {
    assert.equal(normalizeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(normalizeVideoId('@@bad@@'), null);
});

test('sanitizeThumbnail falls back to YouTube thumbnail URL', () => {
    const fallback = sanitizeThumbnail('', 'dQw4w9WgXcQ');
    assert.equal(fallback, 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
});

test('normalizeQueueItem sanitizes title and fills thumbnail fallback', () => {
    const normalized = normalizeQueueItem({
        videoId: 'dQw4w9WgXcQ',
        title: '  hello \u0000 world  ',
        thumbnail: ''
    });
    assert.deepEqual(normalized, {
        videoId: 'dQw4w9WgXcQ',
        title: 'hello  world',
        thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
    });
});

test('clampString truncates and removes control characters', () => {
    assert.equal(clampString('abc\u0000def', 5), 'abcde');
});
