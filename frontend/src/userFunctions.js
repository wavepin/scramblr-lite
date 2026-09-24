import { firebase_db } from "./firebase";
import {
  doc,
  addDoc,
  setDoc,
  getDoc,
  onSnapshot,
  updateDoc,
  increment,
  serverTimestamp,
  collection,
  query,
  orderBy,
  limit,
  startAfter,
  where,
  getDocs,
  arrayUnion,
} from "firebase/firestore";

/**
 * Initialize or update a song document in listening_history when a song is shown.
 * Uses the YouTube video ID as the document ID.
 *
 * Firestore path: users/{userId}/listening_history/{videoId}
 *
 * Fields:
 *   title, artist, genre, youtubeUrl  — song metadata
 *   firstPlayedAt   — timestamp of first time song was shown (set once)
 *   lastPlayedAt    — timestamp of most recent play (updated each time)
 *   totalPlays      — how many times this song was shown/played
 *   totalListenTimeMs — accumulated listen time in milliseconds
 *   liked           — true if user liked, false if toggled off, null initially
 *   disliked        — true if user disliked, false if toggled off, null initially
 *   replays         — times the replay button was clicked
 *   skips           — times the song was skipped (next/prev)
 *   earlySkips      — times skipped before threshold (< 30s AND < 25% duration)
 *   completions     — times the song played to the end naturally
 */
export async function initSongDocument(userId, videoId, songMeta) {
  const songRef = doc(
    firebase_db,
    "users",
    userId,
    "listening_history",
    videoId,
  );

  const snapshot = await getDoc(songRef);

  if (snapshot.exists()) {
    // Song already tracked — just increment play count and update timestamp
    await updateDoc(songRef, {
      totalPlays: increment(1),
      lastPlayedAt: serverTimestamp(),
    });
  } else {
    // First time seeing this song — create full document
    await setDoc(songRef, {
      title: songMeta.title,
      artist: songMeta.artist,
      genre: songMeta.genre,
      youtubeUrl: songMeta.youtubeUrl,
      firstPlayedAt: serverTimestamp(),
      lastPlayedAt: serverTimestamp(),
      totalPlays: 1,
      totalListenTimeMs: 0,
      liked: null,
      disliked: null,
      replays: 0,
      skips: 0,
      earlySkips: 0,
      completions: 0,
    });
  }
}

/**
 * Update specific fields on a song's listening_history document.
 * Use increment() for counters, plain values for toggles.
 *
 * Examples:
 *   updateSongInteraction(uid, vid, { liked: true, disliked: false })
 *   updateSongInteraction(uid, vid, { skips: increment(1) })
 *   updateSongInteraction(uid, vid, { totalListenTimeMs: increment(5000) })
 */
export async function updateSongInteraction(userId, videoId, updates) {
  const songRef = doc(
    firebase_db,
    "users",
    userId,
    "listening_history",
    videoId,
  );
  await updateDoc(songRef, updates);
}

export async function getSongInteractionState(userId, videoId) {
  const songRef = doc(
    firebase_db,
    "users",
    userId,
    "listening_history",
    videoId,
  );
  const snapshot = await getDoc(songRef);

  if (!snapshot.exists()) {
    return {
      liked: null,
      disliked: null,
    };
  }

  const data = snapshot.data();

  return {
    liked: data.liked ?? null,
    disliked: data.disliked ?? null,
  };
}

export async function getPreferences(userId) {
  const prefRef = doc(firebase_db, "users", userId, "preferences", "data");
  const snapshot = await getDoc(prefRef);

  if (!snapshot.exists()) {
    return null;
  }

  return deserializePreferenceMatrices(snapshot.data());
}

export function subscribeToPreferences(userId, onChange, onError) {
  const prefRef = doc(firebase_db, "users", userId, "preferences", "data");
  return onSnapshot(
    prefRef,
    (snapshot) => {
      onChange(
        snapshot.exists() ? deserializePreferenceMatrices(snapshot.data()) : null,
      );
    },
    onError,
  );
}

function serializeMatrixForFirestore(matrix) {
  if (!Array.isArray(matrix)) {
    return matrix;
  }

  if (matrix.length === 0 || !Array.isArray(matrix[0])) {
    return matrix;
  }

  const rows = matrix.length;
  const cols = matrix[0].length;
  const data = [];

  for (const row of matrix) {
    if (!Array.isArray(row) || row.length !== cols) {
      throw new Error("Taste matrix must be rectangular.");
    }

    for (const value of row) {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) {
        throw new Error("Taste matrix contains non-numeric values.");
      }
      data.push(numberValue);
    }
  }

  return {
    data,
    shape: [rows, cols],
  };
}

function deserializeMatrixFromFirestore(value) {
  if (
    value &&
    !Array.isArray(value) &&
    Array.isArray(value.shape) &&
    value.shape.length === 2 &&
    Array.isArray(value.data)
  ) {
    const [rows, cols] = value.shape;
    if (
      Number.isInteger(rows) &&
      Number.isInteger(cols) &&
      rows >= 0 &&
      cols >= 0 &&
      value.data.length === rows * cols
    ) {
      return Array.from({ length: rows }, (_, rowIndex) => {
        const start = rowIndex * cols;
        return value.data.slice(start, start + cols);
      });
    }
  }

  return value;
}

function serializePreferenceMatrices(data) {
  return {
    ...data,
    preference_matrix: serializeMatrixForFirestore(data.preference_matrix),
    avoid_matrix: serializeMatrixForFirestore(data.avoid_matrix),
  };
}

function deserializePreferenceMatrices(data) {
  if (!data) return data;

  return {
    ...data,
    preference_matrix: deserializeMatrixFromFirestore(data.preference_matrix),
    avoid_matrix: deserializeMatrixFromFirestore(data.avoid_matrix),
  };
}

// adds user preferences from survey to firestore
export async function addToPreferences(userId, data) {
  // data: { songs, artists, genres, avoid_genres }
  // Saves to: users/{userId}/preferences/data
  const prefRef = doc(firebase_db, "users", userId, "preferences", "data");
  await setDoc(prefRef, {
    ...serializePreferenceMatrices(data),
    submittedAt: new Date(),
  });
}


async function addVectorDelta(baseMatrix, deltaVector) {
  if (!Array.isArray(baseMatrix) || !Array.isArray(deltaVector)) {
    throw new Error("Taste matrix and delta vector must be arrays.");
  }

  const res = await fetch("/api/apply-delta-vector", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      matrix: baseMatrix,
      delta_vector: deltaVector,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const updatedMatrix = await res.json();
  if (!Array.isArray(updatedMatrix)) {
    throw new Error("Matrix update API returned invalid data.");
  }

  return updatedMatrix;
}

function hasVectorDelta(vector) {
  return Array.isArray(vector) && vector.length > 0;
}

export async function applyTasteVectorDeltas(
  userId,
  { preferenceDeltaVector = [], avoidDeltaVector = [] } = {},
) {
  const hasPreferenceDelta = hasVectorDelta(preferenceDeltaVector);
  const hasAvoidDelta = hasVectorDelta(avoidDeltaVector);

  if (!hasPreferenceDelta && !hasAvoidDelta) {
    return { updated: false, reason: "empty-delta" };
  }

  const prefRef = doc(firebase_db, "users", userId, "preferences", "data");

  const snapshot = await getDoc(prefRef);
  if (!snapshot.exists()) {
    return { updated: false, reason: "missing-preferences" };
  }

  const data = deserializePreferenceMatrices(snapshot.data());
  const currentPreferenceMatrix = data.preference_matrix;
  const currentAvoidMatrix = data.avoid_matrix;

  if (
    hasPreferenceDelta &&
    (!Array.isArray(currentPreferenceMatrix) ||
      currentPreferenceMatrix.length === 0)
  ) {
    return { updated: false, reason: "missing-preference-matrix" };
  }

  if (
    hasAvoidDelta &&
    (!Array.isArray(currentAvoidMatrix) || currentAvoidMatrix.length === 0)
  ) {
    return { updated: false, reason: "missing-avoid-matrix" };
  }

  const updates = {};
  if (hasPreferenceDelta) {
    updates.preference_matrix = serializeMatrixForFirestore(
      await addVectorDelta(currentPreferenceMatrix, preferenceDeltaVector),
    );
  }

  if (hasAvoidDelta) {
    updates.avoid_matrix = serializeMatrixForFirestore(
      await addVectorDelta(currentAvoidMatrix, avoidDeltaVector),
    );
  }

  await updateDoc(prefRef, updates);

  return { updated: true, reason: null };
}

export async function applyPreferenceVectorDelta(userId, deltaVector) {
  return applyTasteVectorDeltas(userId, {
    preferenceDeltaVector: deltaVector,
  });
}

// Re-export increment for use in components
export { increment };

// ─── Song Queue Persistence ─────────────────────────────────────────

/**
 * Read the persisted song queue for a user.
 * Firestore path: users/{userId}/queue/current
 * @returns {{ tracks: Array, currentIndex: number, isGenerating: boolean } | null}
 */
export async function getQueue(userId) {
  const ref = doc(firebase_db, "users", userId, "queue", "current");
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return {
    tracks: data.tracks || [],
    currentIndex: data.currentIndex ?? 0,
    isGenerating: data.isGenerating ?? false,
  };
}

/**
 * Save the full queue (used after initial generation).
 */
export async function saveQueue(userId, tracks, currentIndex = 0) {
  const ref = doc(firebase_db, "users", userId, "queue", "current");
  await setDoc(ref, {
    tracks,
    currentIndex,
    isGenerating: false,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Update only the current index in the queue (called on every song change).
 */
export async function updateQueueIndex(userId, currentIndex) {
  const ref = doc(firebase_db, "users", userId, "queue", "current");
  await updateDoc(ref, { currentIndex, updatedAt: serverTimestamp() });
}

/**
 * Append new tracks to the end of the queue.
 * Uses arrayUnion so duplicates (by full object equality) are skipped.
 */
export async function appendToQueue(userId, newTracks) {
  const ref = doc(firebase_db, "users", userId, "queue", "current");
  await updateDoc(ref, {
    tracks: arrayUnion(...newTracks),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Set the isGenerating flag on the queue document.
 */
export async function setQueueGenerating(userId, flag) {
  const ref = doc(firebase_db, "users", userId, "queue", "current");
  const snapshot = await getDoc(ref);
  if (snapshot.exists()) {
    await updateDoc(ref, { isGenerating: flag });
  } else {
    await setDoc(ref, {
      tracks: [],
      currentIndex: 0,
      isGenerating: flag,
      updatedAt: serverTimestamp(),
    });
  }
}

/**
 * Get all YouTube video IDs from a user's listening history (for dedup).
 * @returns {Set<string>}
 */
export async function getListeningHistoryIds(userId) {
  const colRef = collection(firebase_db, "users", userId, "listening_history");
  const snapshot = await getDocs(colRef);
  return new Set(snapshot.docs.map((d) => d.id));
}

export async function getDislikedSongs(userId) {
  const colRef = collection(firebase_db, "users", userId, "listening_history");
  const dislikedQuery = query(colRef, where("disliked", "==", true));
  const snapshot = await getDocs(dislikedQuery);

  return snapshot.docs
    .map((d) => {
      const data = d.data();
      return {
        name: data.title || data.name || "",
        title: data.title || data.name || "",
        artist: data.artist || "",
      };
    })
    .filter((song) => song.title && song.artist);
}

/**
 * Clear the queue (e.g. when user re-submits survey).
 */
export async function clearQueue(userId) {
  const ref = doc(firebase_db, "users", userId, "queue", "current");
  await setDoc(ref, {
    tracks: [],
    currentIndex: 0,
    isGenerating: false,
    updatedAt: serverTimestamp(),
  });
}

// ─── Custom Playlist Persistence ───────────────────────────────────

function getTimestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Create a playlist metadata document and its independent queue.
 *
 * Firestore paths:
 *   users/{userId}/playlists/{playlistId}
 *   users/{userId}/playlists/{playlistId}/queue/current
 */
export async function createPlaylistWithQueue(
  userId,
  { name = "", startSong, endSong, tracks },
) {
  const playlistsRef = collection(firebase_db, "users", userId, "playlists");
  const playlistRef = await addDoc(playlistsRef, {
    name: name.trim(),
    startSong,
    endSong,
    deleted: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastListenedAt: serverTimestamp(),
  });

  const queueRef = doc(
    firebase_db,
    "users",
    userId,
    "playlists",
    playlistRef.id,
    "queue",
    "current",
  );

  await setDoc(queueRef, {
    tracks,
    currentIndex: 0,
    isGenerating: false,
    updatedAt: serverTimestamp(),
  });

  return playlistRef.id;
}

export async function getPlaylists(userId) {
  const playlistsRef = collection(firebase_db, "users", userId, "playlists");
  const snapshot = await getDocs(playlistsRef);

  return snapshot.docs
    .map((playlistDoc) => ({
      id: playlistDoc.id,
      ...playlistDoc.data(),
    }))
    .filter((playlist) => playlist.deleted !== true)
    .sort((a, b) => {
      const aTime =
        getTimestampMillis(a.lastListenedAt) || getTimestampMillis(a.createdAt);
      const bTime =
        getTimestampMillis(b.lastListenedAt) || getTimestampMillis(b.createdAt);
      return bTime - aTime;
    });
}

export async function getPlaylist(userId, playlistId) {
  const playlistRef = doc(
    firebase_db,
    "users",
    userId,
    "playlists",
    playlistId,
  );
  const snapshot = await getDoc(playlistRef);
  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  if (data.deleted === true) return null;

  return {
    id: snapshot.id,
    ...data,
  };
}

export async function getPlaylistQueue(userId, playlistId) {
  const queueRef = doc(
    firebase_db,
    "users",
    userId,
    "playlists",
    playlistId,
    "queue",
    "current",
  );
  const snapshot = await getDoc(queueRef);
  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  return {
    tracks: data.tracks || [],
    currentIndex: data.currentIndex ?? 0,
    isGenerating: data.isGenerating ?? false,
  };
}

export async function updatePlaylistQueueIndex(userId, playlistId, currentIndex) {
  const queueRef = doc(
    firebase_db,
    "users",
    userId,
    "playlists",
    playlistId,
    "queue",
    "current",
  );
  await updateDoc(queueRef, {
    currentIndex,
    updatedAt: serverTimestamp(),
  });
}

export async function touchPlaylistLastListened(userId, playlistId) {
  const playlistRef = doc(
    firebase_db,
    "users",
    userId,
    "playlists",
    playlistId,
  );
  await updateDoc(playlistRef, {
    lastListenedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function renamePlaylist(userId, playlistId, name) {
  const playlistRef = doc(
    firebase_db,
    "users",
    userId,
    "playlists",
    playlistId,
  );
  await updateDoc(playlistRef, {
    name: name.trim(),
    updatedAt: serverTimestamp(),
  });
}

export async function softDeletePlaylist(userId, playlistId) {
  const playlistRef = doc(
    firebase_db,
    "users",
    userId,
    "playlists",
    playlistId,
  );
  await updateDoc(playlistRef, {
    deleted: true,
    deletedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Fetch a page of listening history for a user with sorting and filtering.
 *
 * @param {string} userId
 * @param {Object} options
 * @param {'desc'|'asc'} options.sortDirection - Sort by lastPlayedAt (default 'desc')
 * @param {'all'|'liked'|'disliked'} options.filter - Filter songs (default 'all')
 * @param {number} options.pageSize - Number of results per page (default 10)
 * @param {import('firebase/firestore').DocumentSnapshot|null} options.startAfterDoc - Cursor for pagination
 * @returns {Promise<{songs: Array, lastDoc: DocumentSnapshot|null, hasMore: boolean}>}
 */
export async function getListeningHistory(
  userId,
  {
    sortDirection = "desc",
    filter = "all",
    pageSize = 10,
    startAfterDoc = null,
  } = {},
) {
  const colRef = collection(firebase_db, "users", userId, "listening_history");

  const constraints = [];

  if (filter === "liked") {
    constraints.push(where("liked", "==", true));
  } else if (filter === "disliked") {
    constraints.push(where("disliked", "==", true));
  }

  constraints.push(orderBy("lastPlayedAt", sortDirection));
  // Fetch one extra to know if there's a next page
  constraints.push(limit(pageSize + 1));

  if (startAfterDoc) {
    constraints.push(startAfter(startAfterDoc));
  }

  const q = query(colRef, ...constraints);
  const snapshot = await getDocs(q);

  const docs = snapshot.docs;
  const hasMore = docs.length > pageSize;
  const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;

  const songs = pageDocs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  const lastDoc = pageDocs.length > 0 ? pageDocs[pageDocs.length - 1] : null;

  return { songs, lastDoc, hasMore };
}

export async function getStartingSong(userId) {
  
  const prefs = await getPreferences(userId); 

  if (!prefs || !prefs.songs || prefs.songs.length === 0) {
    console.warn("No preferred songs found for this user.");
    return null;
  }

  const randomIndex = Math.floor(Math.random() * prefs.songs.length);
  const selectedSong = prefs.songs[randomIndex];

  return `${selectedSong.artist} - ${selectedSong.name}`;
}
