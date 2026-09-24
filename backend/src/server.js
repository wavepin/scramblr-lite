import 'dotenv/config'; // <--- THIS MUST BE LINE 1
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import express from "express";
import cors from "cors";

import {
  searchArtists,
  searchTracks,
  searchAlbums,
  searchGenres,
  getTopTags,
  getArtistTopTracks,
  getTagTopTracks,
  getTrackTopTags,
  getTrackTopTagNames,
} from "./apis/lastfm.js";
import{
  searchURL
} from "./apis/youtube.js";
import { getArtistBio, getTrackGenre } from "./apis/openai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });

const app = express();
const PORT = 3001;
const JSON_BODY_LIMIT = "10mb";

app.use(cors());
app.use(express.json({ limit: JSON_BODY_LIMIT }));

export function validateQuery(req, res) {
  const q = req.query.q;
  if (!q || typeof q !== "string" || q.trim().length === 0) {
    res.status(400).json({ error: 'Missing or empty query parameter "q"' });
    return null;
  }
  if (q.length > 200) {
    res.status(400).json({ error: "Query too long (max 200 characters)" });
    return null;
  }
  return q.trim();
}

export async function runPythonJson(api_point, payload) {
  const baseUrl = process.env.MODEL_SERVICE_URL || "http://127.0.0.1:8000";

  let response;
  try {
    response = await fetch(`${baseUrl}/${api_point}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Could not reach model service for ${api_point}: ${err.message}`);
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      body?.error || body?.detail || `Model service ${api_point} failed with HTTP ${response.status}`,
    );
  }

  return body;
}

export function getName(item) {
  return typeof item === "string" ? item : item?.name;
}

export function normalizeName(name) {
  return name.trim().toLowerCase();
}

function normalizeMatchName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandGenreNames(genres = []) {
  const normalizedGenres = new Set();

  for (const genre of genres || []) {
    const name = normalizeMatchName(getName(genre) || genre);
    if (!name) continue;
    normalizedGenres.add(name);
  }

  return normalizedGenres;
}

function genreNameMatches(name, genreSet) {
  const normalized = normalizeMatchName(name);
  if (!normalized) return false;
  return genreSet.has(normalized);
}

export function tagNamesMatchGenres(tagNames, genres = []) {
  const genreSet = expandGenreNames(genres);
  if (genreSet.size === 0) return false;
  return (tagNames || []).some((tagName) => genreNameMatches(tagName, genreSet));
}

function normalizeSongKeyPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function songKeyFromValues(title, artist) {
  return `${normalizeSongKeyPart(title)}||${normalizeSongKeyPart(artist)}`;
}

function songKeyFromSong(song) {
  return songKeyFromValues(getSongTitle(song), getSongArtist(song));
}

export function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function toSong(track) {
  if (!track?.name) return null;

  const artist =
    typeof track.artist === "string" ? track.artist : track.artist?.name;

  if (!artist) return null;

  return {
    name: track.name,
    artist,
  };
}

export function getSongTitle(song) {
  if (typeof song === "string") return song;
  return song?.title || song?.name || "";
}

export function getSongArtist(song) {
  if (typeof song?.artist === "string") return song.artist;
  return song?.artist?.name || "";
}

export async function getEndingSong(avoidGenres = []) {
  // Endpoint selection should explore broadly; taste bias is handled by vectors.
  const candidateGenres = (await getTopTags())
    .map(getName)
    .filter(Boolean)
    .filter((name) => !tagNamesMatchGenres([name], avoidGenres));

  const remainingGenres = [...candidateGenres];

  while (remainingGenres.length > 0) {
    const randomIndex = Math.floor(Math.random() * remainingGenres.length);
    const [genreName] = remainingGenres.splice(randomIndex, 1);
    const tracks = await getTagTopTracks(genreName, 20);
    const songs = tracks.map(toSong).filter(Boolean);

    if (songs.length > 0) {
      return {
        end_song: pickRandom(songs),
        end_genre: genreName,
      };
    }
  }

  return null;
}

app.get("/api/search/artist", async (req, res) => {
  const q = validateQuery(req, res);
  if (!q) return;
  const results = await searchArtists(q);
  res.json(results);
});

app.get("/api/search/track", async (req, res) => {
  const q = validateQuery(req, res);
  if (!q) return;
  const results = await searchTracks(q);
  res.json(results);
});

app.get("/api/search/album", async (req, res) => {
  const q = validateQuery(req, res);
  if (!q) return;
  const results = await searchAlbums(q);
  res.json(results);
});

app.get("/api/search/genre", async (req, res) => {
  const q = validateQuery(req, res);
  if (!q) return;
  const results = await searchGenres(q);
  res.json(results);
});

app.get("/api/genres", async (req, res) => {
  try {
    const tags = await getTopTags();
    res.json(tags.map((t) => ({ name: t.name })));
  } catch (err) {
    console.error("Error fetching genres:", err);
    res.status(500).json({ error: "Failed to fetch genres" });
  }
});
app.get("/api/search/youtubeURL", async (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist) {
    return res.status(400).json({ error: "Missing title or artist query parameters" });
  }

  try {
    const results = await searchURL(title, artist);
    if (!results) return res.status(404).json({ error: "YouTube video not found" + title });
    res.json(results);
  } catch (err) {
    console.error("Error searching YouTube:", err);
    res.status(500).json({ error: "Failed to fetch YouTube video" });
  }
});
app.get("/api/track/genre", async (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist) {
    return res.status(400).json({ error: 'Missing title or artist query parameters' });
  }
  try {
    const tags = await getTopTags();
    const allowedGenres = ["country", ...tags.map((t) => t.name)];
    const genre = await getTrackGenre(title.trim(), artist.trim(), allowedGenres);
    res.json({ genre });
  } catch (err) {
    console.error("Error fetching track genre:", err);
    res.status(500).json({ error: "Failed to fetch track genre" });
  }
});

app.get("/api/artist/bio", async (req, res) => {
  const artist = req.query.artist;
  if (!artist || typeof artist !== "string" || artist.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "artist" query parameter' });
  }
  try {
    const bio = await getArtistBio(artist.trim());
    res.json({ bio });
  } catch (err) {
    console.error("Error fetching artist bio:", err);
    res.status(500).json({ error: "Failed to fetch artist bio" });
  }
});


app.post("/api/apply-delta-vector", async (req, res) => {
  const {
    matrix,
    delta_vector
  } = req.body || {};

  if (
    !Array.isArray(matrix) ||
    matrix.length === 0 ||
    !Array.isArray(delta_vector) ||
    delta_vector.length === 0
  ) {
    return res.status(400).json({
      error: "Matrix or delta vector is invalid",
    });
  }

  const scriptInput = {
    matrix: matrix,
    delta_vector: delta_vector
  }

  try {
    const matrix = await runPythonJson("apply-delta-vector", scriptInput);
    res.json(matrix);
  } catch (err) {
    console.error("Apply delta vector error:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to apply delta vector" });
  }
});

app.post("/api/recommendations", async (req, res) => {
  const {
    genres,
    artists,
    songs,
    avoid_genres,
    avoid_songs,
    preference_matrix,
    avoid_matrix,
    recommendation_speed,
    start_song,
    end_song,
    queue,
  } = req.body || {};

  const hasRecommendationInput =
    (Array.isArray(genres) && genres.length > 0) ||
    (Array.isArray(artists) && artists.length > 0) ||
    (Array.isArray(songs) && songs.length > 0) ||
    (Array.isArray(preference_matrix) && preference_matrix.length > 0);

  if (!hasRecommendationInput) {
    return res.status(400).json({
      error: "At least one of genres, artists, songs, or preference matrix is required.",
    });
  }

  if (
    recommendation_speed !== undefined &&
    typeof recommendation_speed !== "string"
  ) {
    return res.status(400).json({
      error: "recommendation_speed must be a string.",
    });
  }

  // Build the input for the Python script: extract plain name strings
  const scriptInput = {
    genres: (genres || []).map((g) => (typeof g === "string" ? g : g.name)),
    artists: (artists || []).map((a) => (typeof a === "string" ? a : a.name)),
    songs: (songs || []).map((s) =>
      typeof s === "string"
        ? { name: s, artist: "" }
        : { name: s.name, artist: s.artist || "" },
    ),
    avoid_genres: (avoid_genres || []).map((g) =>
      typeof g === "string" ? g : g.name,
    ),
    avoid_songs: (Array.isArray(avoid_songs) ? avoid_songs : []).map((s) =>
      typeof s === "string"
        ? { name: s, artist: "" }
        : { name: s.name || s.title, artist: s.artist || "" },
    ),
    preference_matrix: preference_matrix,
    avoid_matrix: avoid_matrix || [],
    recommendation_speed: recommendation_speed,
    start_song: start_song,
    end_song: end_song,
    queue: queue
  };

  try {
    const rawResults = await runPythonJson("recommend", scriptInput);
    if (!Array.isArray(rawResults)) {
      return res.status(502).json({
        error: "Recommendation model returned invalid data.",
      });
    }

    const avoidedGenres = Array.isArray(avoid_genres) ? avoid_genres : [];
    const avoidedSongKeys = new Set(
      (Array.isArray(avoid_songs) ? avoid_songs : [])
        .map(songKeyFromSong)
        .filter((key) => key !== "||"),
    );

    // Enrich each result with YouTube URL and Last.fm tags in parallel, then
    // enforce hard user-facing exclusions before anything reaches playback.
    // Preferred genres guide model generation; sparse Last.fm tags should not
    // hide otherwise valid playback candidates.
    const enriched = await Promise.all(
      rawResults.map(async (song) => {
        const title = song.title || song.name;
        const artist = song.artist;
        if (avoidedSongKeys.has(songKeyFromValues(title, artist))) return null;

        const [ytResult, tagNames] = await Promise.all([
          searchURL(title, artist).catch(() => null),
          getTrackTopTagNames(artist, title).catch(() => []),
        ]);

        if (!ytResult) return null; // No YouTube video found — skip

        if (tagNamesMatchGenres(tagNames, avoidedGenres)) return null;

        return {
          title,
          artist,
          genre: tagNames[0] || "Unknown",
          youtubeUrl: ytResult.url,
        };
      }),
    );

    const tracks = enriched.filter(Boolean);
    if (rawResults.length > 0 && tracks.length === 0) {
      return res.status(502).json({
        error:
          "Generated recommendations could not be resolved to playable YouTube videos.",
      });
    }
    res.json(tracks);
  } catch (err) {
    console.error("Recommendation error:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to generate recommendations" });
  }
});

export function normalizeSelectedSong(song, fieldName) {
  if (!song || typeof song !== "object") {
    throw new Error(`${fieldName} is required.`);
  }

  const name = String(song.name || song.title || "").trim();
  const artist = String(song.artist || "").trim();
  if (!name || !artist) {
    throw new Error(`${fieldName}.name and ${fieldName}.artist are required.`);
  }

  return { name, artist };
}

export async function enrichPlaylistSong(song) {
  const title = song.title || song.name;
  const artist = song.artist;
  const [ytResult, genre] = await Promise.all([
    searchURL(title, artist).catch(() => null),
    getTrackTopTags(artist, title).catch(() => "Unknown"),
  ]);

  if (!ytResult) return null;

  return {
    title,
    artist,
    genre,
    youtubeUrl: ytResult.url,
  };
}

app.post("/api/playlists/generate", async (req, res) => {
  let startSong;
  let endSong;
  const { preference_matrix, avoid_matrix } = req.body || {};

  try {
    startSong = normalizeSelectedSong(req.body?.startSong, "startSong");
    endSong = normalizeSelectedSong(req.body?.endSong, "endSong");
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const bridgeSongs = await runPythonJson(
      "generate-playlist",
      {
        startSong,
        endSong,
        bridgeCount: 10,
        preference_matrix: Array.isArray(preference_matrix)
          ? preference_matrix
          : [],
        avoid_matrix: Array.isArray(avoid_matrix) ? avoid_matrix : [],
      },
      600000,
    );

    if (!Array.isArray(bridgeSongs)) {
      return res.status(502).json({ error: "Playlist generator returned invalid data." });
    }

    const bridgeKeys = new Set();
    const uniqueBridgeSongs = bridgeSongs.filter((song) => {
      const title = String(song?.title || "").trim();
      const artist = String(song?.artist || "").trim();
      if (!title || !artist) return false;

      const key = `${title.toLowerCase()}||${artist.toLowerCase()}`;
      if (bridgeKeys.has(key)) return false;

      bridgeKeys.add(key);
      return true;
    });

    const enriched = await Promise.all([
      enrichPlaylistSong(startSong),
      ...uniqueBridgeSongs.map((song) => enrichPlaylistSong(song)),
      enrichPlaylistSong(endSong),
    ]);

    const startTrack = enriched[0];
    const endTrack = enriched[enriched.length - 1];
    const bridgeTracks = enriched.slice(1, -1).filter(Boolean).slice(0, 10);

    if (!startTrack || !endTrack) {
      return res.status(502).json({
        error: "Could not resolve the selected start or end song to a playable YouTube video.",
      });
    }

    if (bridgeTracks.length < 10) {
      return res.status(502).json({
        error: "Could not resolve enough generated songs to playable YouTube videos.",
      });
    }

    res.json({
      tracks: [startTrack, ...bridgeTracks, endTrack],
    });
  } catch (err) {
    console.error("Playlist generation error:", err);
    res.status(500).json({
      error: err.message || "Failed to generate playlist",
    });
  }
});

app.post("/api/process-preferences", async (req, res) => {
  const { genres, artists, songs, avoid_genres} = req.body || {};

  // Build the input for the Python script: extract plain name strings
  const scriptInput = {
    genres: (genres || []).map((g) => (typeof g === "string" ? g : g.name)),
    artists: (artists || []).map((a) => (typeof a === "string" ? a : a.name)),
    songs: (songs || []).map((s) =>
      typeof s === "string"
        ? { name: s, artist: "" }
        : { name: s.name, artist: s.artist || "" },
    ),
    avoid_genres: (avoid_genres || []).map((g) =>
      typeof g === "string" ? g : g.name,
    ),
  };

  try {
    const matrices = await runPythonJson("process-preferences", scriptInput);
    res.json(matrices);
  } catch (err) {
    console.error("Preference processing error:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to process preferences" });
  }
});

app.post("/api/process-interaction-vector", async (req, res) => {
  const {
    title,
    artist,
    previousReaction = "none",
    nextReaction = "none",
  } = req.body || {};

  if (!title || !artist) {
    return res.status(400).json({
      error: "Both title and artist are required.",
    });
  }

  try {
    const result = await runPythonJson("update-preferences", {
      title,
      artist,
      previousReaction,
      nextReaction,
    });
    res.json(result);
  } catch (err) {
    console.error("Interaction vector processing error:", err);
    res.status(500).json({
      error: err.message || "Failed to process interaction vector",
    });
  }
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

export { app };

app.post("/api/recommend/getStartingSong", async (req, res) => {
  const { artists, genres, avoid_genres } = req.body;

  if (!artists && !genres) {
    return res.status(400).json({ error: "No preferences provided" });
  }

  try {
    let masterPool = [];

    const artistPromises = (artists || []).map(async (artist) => {
      const artistName = getName(artist);
      if (!artistName) return [];

      const tracks = await getArtistTopTracks(artistName, 3);
      return tracks.map(toSong).filter(Boolean);
    });

    const genrePromises = (genres || []).map(async (genre) => {
      const genreName = getName(genre);
      if (!genreName) return [];

      const tracks = await getTagTopTracks(genreName, 3);
      return tracks.map(toSong).filter(Boolean);
    });

    const results = await Promise.all([...artistPromises, ...genrePromises]);
    masterPool = results.flat();

    if (masterPool.length === 0) {
      return res.status(404).json({ error: "No tracks found for these preferences" });
    }

    const ending = await getEndingSong(avoid_genres || []);
    if (!ending) {
      return res.status(404).json({ error: "No end track found from allowed genres" });
    }

    const startSong = pickRandom(masterPool);

    res.json({
      start_song: startSong,
      ...ending,
    });
  } catch (err) {
    console.error("Discovery Error:", err);
    res.status(500).json({ error: "Failed to generate recommendation" });
  }
});

app.post("/api/recommend/getNewEnd", async (req, res) => {
  const { song, avoid_genres } = req.body;

  if (!song) {
    return res.status(400).json({ error: "No song to continue from provided" });
  }

  try {
    const title = getSongTitle(song);
    const artist = getSongArtist(song);

    if (!title || !artist) {
      return res.status(400).json({ error: "Song title and artist are required" });
    }

    const ending = await getEndingSong(avoid_genres || []);
    if (!ending) {
      return res.status(404).json({ error: "No end track found from allowed genres" });
    }

    res.json({
      ...ending,
      start_song: song
    });
  } catch (err) {
    console.error("New end discovery error:", err);
    res.status(500).json({ error: "Failed to generate new ending song" });
  }
});


