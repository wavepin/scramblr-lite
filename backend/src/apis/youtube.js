export { searchURL };

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

function extractJsonObject(source, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function* parseVideoRenderers(html) {
  const marker = '"videoRenderer":';
  let searchFrom = 0;

  while (searchFrom < html.length) {
    const markerIndex = html.indexOf(marker, searchFrom);
    if (markerIndex === -1) return;

    const objectStart = html.indexOf("{", markerIndex + marker.length);
    if (objectStart === -1) return;

    const json = extractJsonObject(html, objectStart);
    if (!json) return;

    try {
      yield JSON.parse(json);
    } catch {
      // Ignore malformed renderer snippets and keep scanning.
    }

    searchFrom = objectStart + json.length;
  }
}

function getText(value) {
  if (!value) return null;
  if (typeof value.simpleText === "string") return value.simpleText;
  if (Array.isArray(value.runs)) {
    return value.runs.map((run) => run.text).join("");
  }
  return null;
}

function isShortsRenderer(renderer) {
  const navigationUrl =
    renderer.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
  if (navigationUrl?.startsWith("/shorts/")) return true;

  for (const overlay of renderer.thumbnailOverlays ?? []) {
    const timeStatus = overlay.thumbnailOverlayTimeStatusRenderer;
    if (timeStatus?.style === "SHORTS") return true;
    if (getText(timeStatus?.text)?.toUpperCase() === "SHORTS") return true;
  }

  return JSON.stringify(renderer).includes("WEB_PAGE_TYPE_SHORTS");
}

function parseFirstVideoId(html) {
  for (const renderer of parseVideoRenderers(html)) {
    if (
      renderer.videoId &&
      VIDEO_ID_PATTERN.test(renderer.videoId) &&
      !isShortsRenderer(renderer)
    ) {
      return renderer.videoId;
    }
  }

  return null;
}

async function searchURLFallback(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`YouTube fallback HTTP Error: ${response.status}`);
  }

  const html = await response.text();
  const videoId = parseFirstVideoId(html);
  if (!videoId) return null;

  return {
    id: videoId,
    title: query,
    url: `https://youtube.com/watch?v=${videoId}`,
    tags: undefined,
  };
}

async function searchURL(title, artist) {
  const API_KEY = process.env.YOUTUBE_API_KEY;
  const API_URL = "https://www.googleapis.com/youtube/v3/search";
  if (!title || !artist) {
    throw new Error("Title and artist required");
  }
  const query = `${title} ${artist}`;
  const url = `${API_URL}?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${API_KEY}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 403) {
        console.log(
          `YouTube API quota hit; using search-page fallback for: ${query}`,
        );
        return await searchURLFallback(query);
      }
      throw new Error(`HTTP Error: ${response.status}`);
    }
    const data = await response.json();
    const video = data.items?.[0];
    if (!video?.id?.videoId) return null;
    const results = {
      id: video.id.videoId,
      title: video.snippet.title,
      url: `https://youtube.com/watch?v=${video.id.videoId}`,
      tags: video.snippet.tags,
    };
    const titleLower = title.toLowerCase();
    const artistLower = artist.toLowerCase();
    const videoTitleLower = results.title.toLowerCase();
    if (
      videoTitleLower.includes(artistLower) ||
      videoTitleLower.includes(titleLower)
    ) {
      return results;
    }
  } catch (err) {
    console.error("Youtube search error:", err);
    return null;
  }
}
