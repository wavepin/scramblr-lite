export {
  searchArtists,
  searchTracks,
  searchAlbums,
  searchGenres,
  getTopTags,
  getArtistTopTracks,
  getTagTopTracks,
  getTrackTopTags,
  getTrackTopTagNames,
};

const API_URL = "https://ws.audioscrobbler.com/2.0/";

let cachedTopTags = null;

async function lastfmFetch(params) {
  const url = new URL(API_URL);
  url.searchParams.set("api_key", process.env.LASTFM_API_KEY);
  url.searchParams.set("format", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Last.fm API error: ${response.status}`);
  }
  return response.json();
}

async function searchArtists(query) {
  try {
    const data = await lastfmFetch({
      method: "artist.search",
      artist: query,
      limit: 5,
    });
    const matches = data?.results?.artistmatches?.artist;
    if (!matches || matches.length === 0) return [];
    return matches.map((a) => ({
      name: a.name,
      url: a.url,
      mbid: a.mbid || null,
    }));
  } catch (error) {
    console.error("Error searching artists:", error);
    return [];
  }
}

async function searchTracks(query) {
  try {
    const data = await lastfmFetch({
      method: "track.search",
      track: query,
      limit: 5,
    });
    console.log("DEBUG: Last.fm Raw Data:", JSON.stringify(data));
    const matches = data?.results?.trackmatches?.track;
    if (!matches || matches.length === 0) return [];
    return matches.map((t) => ({
      name: t.name,
      artist: t.artist || "Unknown",
      url: t.url,
    }));
  } catch (error) {
    console.error("Error searching tracks:", error);
    return [];
  }
}

async function searchAlbums(query) {
  try {
    const data = await lastfmFetch({
      method: "album.search",
      album: query,
      limit: 5,
    });
    const matches = data?.results?.albummatches?.album;
    if (!matches || matches.length === 0) return [];
    return matches.map((a) => ({
      name: a.name,
      artist: a.artist || "Unknown",
      url: a.url,
    }));
  } catch (error) {
    console.error("Error searching albums:", error);
    return [];
  }
}

async function getTopTags() {
  if (cachedTopTags) return cachedTopTags;
  try {
    const data = await lastfmFetch({ method: "tag.getTopTags" });
    cachedTopTags = data?.toptags?.tag || [];
    return cachedTopTags;
  } catch (error) {
    console.error("Error fetching top tags:", error);
    return [];
  }
}

async function searchGenres(query) {
  const tags = await getTopTags();
  const lower = query.toLowerCase();
  const matches = tags.filter((t) => t.name.toLowerCase().includes(lower));
  return matches.slice(0, 5).map((t) => ({
    name: t.name,
  }));
}

async function getTrackTopTags(artist, trackName) {
  const tags = await getTrackTopTagNames(artist, trackName, 1);
  return tags[0] || "Unknown";
}

async function getTrackTopTagNames(artist, trackName, limit = 10) {
  try {
    const data = await lastfmFetch({
      method: "track.getTopTags",
      artist,
      track: trackName,
    });
    const tags = data?.toptags?.tag;
    if (!tags || tags.length === 0) return [];
    const tagList = Array.isArray(tags) ? tags : [tags];
    return tagList
      .map((tag) => tag?.name)
      .filter(Boolean)
      .slice(0, limit);
  } catch (error) {
    console.error("Error fetching track top tags:", error);
    return [];
  }
}

async function getArtistTopTracks(artistName, limit = 3) {
  const data = await lastfmFetch({
    method: "artist.gettoptracks",
    artist: artistName,
    limit: limit,
  });
  const tracks = data?.toptracks?.track || [];
  return Array.isArray(tracks) ? tracks : [tracks];
}

async function getTagTopTracks(tagName, limit = 3) {
  const data = await lastfmFetch({
    method: "tag.gettoptracks",
    tag: tagName,
    limit: limit,
  });
  const tracks = data?.tracks?.track || data?.toptracks?.track || [];
  return Array.isArray(tracks) ? tracks : [tracks];
}
