const keysStr = process.env.YOUTUBE_API_KEY || '';
const keys = keysStr.split(',').map(k => k.trim()).filter(Boolean);

if (keys.length === 0) {
  console.log('STATUS: NO_KEYS_FOUND');
  process.exit(0);
}

console.log(`STATUS: FOUND_${keys.length}_KEYS`);

async function checkKey(key, index) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&q=test&key=${key}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (resp.ok) {
      console.log(`KEY_${index}: OK (Remaining quota likely available)`);
    } else {
      if (resp.status === 403 && data.error?.errors?.[0]?.reason === 'quotaExceeded') {
        console.log(`KEY_${index}: QUOTA_EXCEEDED (403)`);
      } else {
        console.log(`KEY_${index}: ERROR_${resp.status} (${data.error?.message || 'Unknown error'})`);
      }
    }
  } catch (err) {
    console.log(`KEY_${index}: FETCH_FAILED (${err.message})`);
  }
}

async function run() {
  for (let i = 0; i < keys.length; i++) {
    await checkKey(keys[i], i);
  }
}

run();
