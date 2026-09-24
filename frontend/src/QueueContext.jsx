import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";
import {
  getPreferences,
  getDislikedSongs,
  subscribeToPreferences,
  getQueue,
  saveQueue,
  updateQueueIndex,
  setQueueGenerating,
  clearQueue,
} from "./userFunctions";

const REFILL_THRESHOLD = 3; // generate more when ≤3 songs remain ahead

function shouldRefillQueue(idx, tracksList) {
  if (!Array.isArray(tracksList) || tracksList.length === 0) return false;
  return tracksList.length - idx - 1 <= REFILL_THRESHOLD;
}

function getYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  return match ? match[1] : url;
}

const QueueContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useQueue() {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error("useQueue must be used inside <QueueProvider>");
  return ctx;
}

export function QueueProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined=loading, null=no auth
  const [preferences, setPreferences] = useState(undefined); // undefined=loading, null=no survey
  const [tracks, setTracks] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false); // queue loaded from Firestore
  const [isGenerating, setIsGenerating] = useState(false);

  const isGeneratingRef = useRef(false);
  const tracksRef = useRef(tracks);
  const currentIndexRef = useRef(currentIndex);
  const userRef = useRef(user);
  const hasPreferences = preferences !== undefined && preferences !== null;

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);
  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // ─── Auth listener ──────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser || null);
      if (!firebaseUser) {
        setPreferences(undefined);
        setTracks([]);
        setCurrentIndex(0);
        setIsLoaded(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // ─── Fetch preferences ─────────────────────────────────────────
  useEffect(() => {
    if (!user) return undefined;

    return subscribeToPreferences(
      user.uid,
      (data) => {
        setPreferences(data);
      },
      (err) => {
        console.warn("Failed to subscribe to preferences:", err);
        setPreferences(null);
      },
    );
  }, [user]);

  // ─── Load queue from Firestore once auth + prefs resolved ──────
  useEffect(() => {
    if (!user || !hasPreferences) return;
    let ignore = false;

    (async () => {
      try {
        const q = await getQueue(user.uid);
        if (ignore) return;

        if (q && q.tracks.length > 0) {
          // Resume existing queue
          setTracks(q.tracks);
          setCurrentIndex(q.currentIndex);
          tracksRef.current = q.tracks;
          currentIndexRef.current = q.currentIndex;

          if (shouldRefillQueue(q.currentIndex, q.tracks)) {
            generateRecommendations(false, q);
          }
          setIsLoaded(true);
        } else {
          // No queue yet — mark loaded (empty) and trigger generation
          setIsLoaded(true);
          generateRecommendations(true, null);
        }
      } catch (err) {
        console.warn("Failed to load queue:", err);
        if (!ignore) setIsLoaded(true);
      }
    })();

    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, hasPreferences]);

  // remove duplicates from a track list
  function removeDuplicates(newSongs) {
    // ── Deduplicate ─────────────────────────────────────────────
    // Only exclude songs already present in the queue, plus duplicates
    // within the newly generated batch itself.
    const existingIds = new Set(
      tracksRef.current.map((t) => getYouTubeId(t.youtubeUrl)),
    );
    const exclusionSet = new Set(existingIds);

    // Also deduplicate by title+artist (case insensitive)
    const existingKeys = new Set(
      tracksRef.current.map(
        (t) =>
          `${t.title.toLowerCase().trim()}||${t.artist.toLowerCase().trim()}`,
      ),
    );

    const uniqueSongs = newSongs.filter((s) => {
      const vid = getYouTubeId(s.youtubeUrl);
      const key = `${s.title.toLowerCase().trim()}||${s.artist.toLowerCase().trim()}`;
      if (exclusionSet.has(vid) || existingKeys.has(key)) return false;
      // Add to sets so subsequent songs in the same batch are also deduped
      exclusionSet.add(vid);
      existingKeys.add(key);
      return true;
    });
    return uniqueSongs;
  }

  // ─── Generate recommendations ──────────────────────────────────
  const generateRecommendations = useCallback(async (isInitial = false, queue = null) => {
    const u = userRef.current;
    if (!u || isGeneratingRef.current) return;

    isGeneratingRef.current = true;
    setIsGenerating(true);

    try {
      await setQueueGenerating(u.uid, true);

      // Fetch preferences fresh for the request body
      const prefs = await getPreferences(u.uid);
      if (!prefs) {
        console.warn("No preferences found, skipping generation.");
        return;
      }

      const dislikedSongs = await getDislikedSongs(u.uid).catch((err) => {
        console.warn("Failed to load disliked songs for recommendation filter:", err);
        return [];
      });

      let start_end_res;
      if (isInitial) {
        start_end_res = await fetch("/api/recommend/getStartingSong", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artists: prefs.artists || [],
            genres: prefs.genres || [],
            avoid_genres: prefs.avoid_genres || [],
          })
        })
      } else {
        const queueTracks = queue?.tracks || tracksRef.current;
        const lastQueuedSong = queueTracks[queueTracks.length - 1];

        if (!lastQueuedSong) {
          console.warn("No queued song found to continue recommendations from.");
          return;
        }

        start_end_res = await fetch("/api/recommend/getNewEnd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            song: lastQueuedSong,
            genres: prefs.genres || [],
            avoid_genres: prefs.avoid_genres || [],
          })
        })
      }

      if (!start_end_res.ok) {
        const errBody = await start_end_res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${start_end_res.status}`);
      }

      const start_end = await start_end_res.json();

      const res = await fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          genres: prefs.genres || [],
          artists: prefs.artists || [],
          songs: prefs.songs || [],
          avoid_genres: prefs.avoid_genres || [],
          avoid_songs: dislikedSongs,
          preference_matrix: prefs.preference_matrix || prefs.preference_vector || [],
          avoid_matrix: prefs.avoid_matrix || prefs.avoid_vector || [],
          recommendation_speed: prefs.recommendation_speed || "regular",
          start_song: start_end.start_song,
          end_song: start_end.end_song,
          queue: queue || []
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      const newSongs = await res.json();

      if (!Array.isArray(newSongs) || newSongs.length === 0) {
        console.warn("Backend returned no playable recommendations.");
        return;
      }

      const uniqueSongs = removeDuplicates(newSongs);

      if (uniqueSongs.length === 0) {
        console.warn("All recommended songs were duplicates.");
        return;
      }

      if (isInitial && tracksRef.current.length === 0) {
        // First generation — save as full queue
        setTracks(uniqueSongs);
        setCurrentIndex(0);
        await saveQueue(u.uid, uniqueSongs, 0);
      } else {
        // Append to existing queue
        const updatedTracks = [...tracksRef.current, ...uniqueSongs];
        setTracks(updatedTracks);
        // We need to write the full tracks array because arrayUnion compares
        // by deep equality which can be fragile. Use saveQueue with current index.
        await saveQueue(u.uid, updatedTracks, currentIndexRef.current);
      }
    } catch (err) {
      console.error("Recommendation generation failed:", err);
    } finally {
      isGeneratingRef.current = false;
      setIsGenerating(false);
      const u = userRef.current;
      if (u) {
        setQueueGenerating(u.uid, false).catch(() => {});
      }
    }
  }, []);

  // ─── Check if we need to refill ────────────────────────────────
  const checkRefill = useCallback(
    (idx, tracksList) => {
      if (shouldRefillQueue(idx, tracksList) && !isGeneratingRef.current) {
        generateRecommendations(false, {
          tracks: tracksList,
          currentIndex: idx
        });
      }
    },
    [generateRecommendations],
  );

  // ─── Public API ────────────────────────────────────────────────

  const goToIndex = useCallback(
    async (newIndex) => {
      currentIndexRef.current = newIndex;
      setCurrentIndex(newIndex);
      const u = userRef.current;
      if (u) {
        updateQueueIndex(u.uid, newIndex).catch((err) =>
          console.warn("Failed to persist queue index:", err),
        );
      }
      checkRefill(newIndex, tracksRef.current);
    },
    [checkRefill],
  );

  const next = useCallback(async () => {
    const nextIdx = currentIndexRef.current + 1;
    if (nextIdx >= tracksRef.current.length) {
      // Wrap around to 0 if at end (or could stop)
      await goToIndex(0);
    } else {
      await goToIndex(nextIdx);
    }
  }, [goToIndex]);

  const prev = useCallback(async () => {
    const prevIdx = currentIndexRef.current - 1;
    if (prevIdx < 0) {
      await goToIndex(tracksRef.current.length - 1);
    } else {
      await goToIndex(prevIdx);
    }
  }, [goToIndex]);

  /**
   * Insert a song right after the current position and jump to it.
   * Used when user clicks a song from Activity page.
   * Allows the song even if it's in listening history (user chose it explicitly).
   */
  const insertAndPlay = useCallback(async (song) => {
    const insertIdx = Math.min(
      currentIndexRef.current + 1,
      tracksRef.current.length,
    );
    const updatedTracks = [...tracksRef.current];
    updatedTracks.splice(insertIdx, 0, song);
    setTracks(updatedTracks);
    setCurrentIndex(insertIdx);

    const u = userRef.current;
    if (u) {
      saveQueue(u.uid, updatedTracks, insertIdx).catch((err) =>
        console.warn("Failed to persist queue after insert:", err),
      );
    }
  }, []);

  const setPreferencesData = useCallback((nextPreferences) => {
    setPreferences(nextPreferences);
  }, []);

  const resetQueueForNewPreferences = useCallback(async () => {
    const u = userRef.current;
    if (!u) return;

    tracksRef.current = [];
    currentIndexRef.current = 0;
    setTracks([]);
    setCurrentIndex(0);
    setIsLoaded(true);

    await clearQueue(u.uid);
    tracksRef.current = [];
    currentIndexRef.current = 0;
    setTracks([]);
    setCurrentIndex(0);
    void generateRecommendations(true, null);
  }, [generateRecommendations]);

  const value = {
    user,
    preferences,
    tracks,
    currentIndex,
    isLoaded,
    isGenerating,
    goToIndex,
    next,
    prev,
    insertAndPlay,
    setPreferencesData,
    resetQueueForNewPreferences,
  };

  return (
    <QueueContext.Provider value={value}>{children}</QueueContext.Provider>
  );
}
