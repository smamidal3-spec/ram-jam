const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

async function youtubeSearch(query, maxResults = 1) {
    if (!YOUTUBE_API_KEY) {
        console.error("NO YOUTUBE API KEY");
        return [];
    }
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;

    console.log("Fetching:", url);
    const resp = await fetch(url);

    if (!resp.ok) {
        console.error("HTTP ERROR", resp.status, await resp.text());
        return [];
    }
    const data = await resp.json();
    console.log("Data:", JSON.stringify(data, null, 2));
}

youtubeSearch("Bruno Mars Finesse official audio", 1);
