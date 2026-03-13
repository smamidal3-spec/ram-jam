const ytSearch = require('yt-search');

async function testSearch() {
  const query = 'rick roll';
  try {
    console.log('Testing yt-search scraping...');
    const results = await ytSearch(query);
    if (results && results.videos && results.videos.length > 0) {
      console.log('yt-search SUCCESS:', results.videos[0].title);
    } else {
      console.log('yt-search FAILED: No results');
    }
  } catch (err) {
    console.error('yt-search ERROR:', err.message);
  }
}

testSearch();
