import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "../firebase";
import logo from "../assets/scramblr.png";
import logoutIcon from "../assets/logout.png";
import playbackIcon from "../assets/playback.png";
import playlistIcon from "../assets/playlist.png";
import historyIcon from "../assets/listeninghistory.png";
import surveyIcon from "../assets/survey.png";
import {
  createPlaylistWithQueue,
  getPlaylist,
  getPlaylistQueue,
  getPlaylists,
  getPreferences,
  renamePlaylist,
  softDeletePlaylist,
  touchPlaylistLastListened,
  updatePlaylistQueueIndex,
} from "../userFunctions";
import "./Playlist.css";

const BRIDGE_COPY =
  "This can take a few minutes while the playlist is mapped and made playable.";
const SEARCH_DEBOUNCE_MS = 500;
const MIN_SEARCH_CHARS = 2;
const SEARCH_CACHE_MAX_ENTRIES = 100;
const searchResultCache = new Map();

function formatSongLabel(song) {
  if (!song) return "";
  return song.artist ? `${song.name} - ${song.artist}` : song.name;
}

function getYouTubeId(url) {
  const match = url?.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  return match ? match[1] : url;
}

function getSearchInputState(value) {
  return {
    query: value.trim(),
  };
}

function getSearchCacheKey(endpoint, query) {
  return `${endpoint}:${query.trim().toLowerCase()}`;
}

function cacheSearchResults(cacheKey, results) {
  if (
    searchResultCache.size >= SEARCH_CACHE_MAX_ENTRIES &&
    !searchResultCache.has(cacheKey)
  ) {
    const oldestKey = searchResultCache.keys().next().value;
    searchResultCache.delete(oldestKey);
  }

  searchResultCache.set(cacheKey, results);
}

function getSongKey(song) {
  if (!song) return "";
  const name = String(song.name || song.title || "").trim().toLowerCase();
  const artist = String(song.artist || "").trim().toLowerCase();
  return `${name}::${artist}`;
}

function isSameSong(firstSong, secondSong) {
  const firstKey = getSongKey(firstSong);
  const secondKey = getSongKey(secondSong);
  return Boolean(firstKey && secondKey && firstKey === secondKey);
}

function getYouTubeEmbedUrl(videoId) {
  const params = new URLSearchParams({
    autoplay: "1",
    enablejsapi: "1",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
  });

  if (window.location.origin) {
    params.set("origin", window.location.origin);
  }

  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

let ytApiLoadPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) {
    return Promise.resolve(window.YT);
  }
  if (ytApiLoadPromise) return ytApiLoadPromise;

  ytApiLoadPromise = new Promise((resolve, reject) => {
    let settled = false;
    let pollId;
    let timeoutId;

    const finish = () => {
      if (settled || !(window.YT && window.YT.Player)) return;
      settled = true;
      window.clearInterval(pollId);
      window.clearTimeout(timeoutId);
      resolve(window.YT);
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollId);
      window.clearTimeout(timeoutId);
      reject(new Error("YouTube IFrame API failed to load."));
    };

    const existing = document.querySelector(
      'script[src*="youtube.com/iframe_api"]',
    );
    const tag = existing || document.createElement("script");

    if (!existing) {
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      document.head.appendChild(tag);
    }

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (previousReady) previousReady();
      finish();
    };

    tag.addEventListener("load", finish, { once: true });
    tag.addEventListener("error", fail, { once: true });
    pollId = window.setInterval(finish, 100);
    timeoutId = window.setTimeout(fail, 10000);
    finish();
  });

  return ytApiLoadPromise;
}

function SongSearchField({ label, placeholder, selectedSong, onSelect }) {
  const [inputValue, setInputValue] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const debounceTimerRef = useRef(null);
  const requestIdRef = useRef(0);
  const endpoint = "/api/search/track";
  const searchState = useMemo(
    () => getSearchInputState(inputValue),
    [inputValue],
  );
  const canSearch = searchState.query.length >= MIN_SEARCH_CHARS;
  const hasSearchInput = Boolean(inputValue.trim());

  useEffect(() => {
    setInputValue(selectedSong ? formatSongLabel(selectedSong) : "");
  }, [selectedSong]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const search = useCallback(async (query) => {
    const q = query.trim();
    if (!q) return;
    const cacheKey = getSearchCacheKey(endpoint, q);
    const cachedResults = searchResultCache.get(cacheKey);

    if (cachedResults) {
      setResults(cachedResults);
      setNoResults(cachedResults.length === 0);
      setLoading(false);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setResults([]);
    setNoResults(false);
    setOpen(true);

    try {
      const response = await fetch(`${endpoint}?q=${encodeURIComponent(q)}`);
      if (!response.ok) throw new Error("Search failed");

      const data = await response.json();
      const nextResults = Array.isArray(data) ? data.slice(0, 5) : [];
      if (requestIdRef.current !== requestId) return;
      cacheSearchResults(cacheKey, nextResults);
      if (nextResults.length === 0) {
        setNoResults(true);
      } else {
        setResults(nextResults);
      }
    } catch {
      if (requestIdRef.current !== requestId) return;
      setNoResults(true);
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    clearTimeout(debounceTimerRef.current);

    if (!open || !hasSearchInput || !canSearch) {
      requestIdRef.current += 1;
      setLoading(false);
      setResults([]);
      setNoResults(false);
      return undefined;
    }

    requestIdRef.current += 1;

    const cacheKey = getSearchCacheKey(endpoint, searchState.query);
    const cachedResults = searchResultCache.get(cacheKey);

    if (cachedResults) {
      setResults(cachedResults);
      setNoResults(cachedResults.length === 0);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    setResults([]);
    setNoResults(false);

    debounceTimerRef.current = setTimeout(() => {
      search(searchState.query);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(debounceTimerRef.current);
  }, [canSearch, hasSearchInput, open, search, searchState.query]);

  function handleChange(event) {
    setInputValue(event.target.value);
    setOpen(true);
    if (selectedSong) onSelect(null);
  }

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      clearTimeout(debounceTimerRef.current);
      if (canSearch) search(searchState.query);
    }
  }

  function selectSong(song) {
    onSelect({
      name: song.name,
      artist: song.artist,
      url: song.url || null,
    });
    setInputValue(formatSongLabel(song));
    setResults([]);
    setNoResults(false);
    setOpen(false);
  }

  const showStartTyping = open && !inputValue.trim();
  const showTooShort =
    open &&
    inputValue.trim() &&
    searchState.query.length > 0 &&
    searchState.query.length < MIN_SEARCH_CHARS;

  return (
    <div className="playlist-input-group">
      <label>{label}</label>
      <div className="playlist-search-row" ref={wrapperRef}>
        <input
          type="text"
          value={inputValue}
          onChange={handleChange}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
        />
        <div className={`playlist-dropdown${open ? " active" : ""}`}>
          {showStartTyping && (
            <div className="playlist-dropdown-status">
              Start typing to search.
            </div>
          )}
          {showTooShort && (
            <div className="playlist-dropdown-status">
              Type at least {MIN_SEARCH_CHARS} characters.
            </div>
          )}
          {loading && (
            <div className="playlist-dropdown-status">Searching…</div>
          )}
          {noResults && (
            <div className="playlist-dropdown-status">No results found.</div>
          )}
          {results.map((song) => (
            <button
              type="button"
              key={`${song.name}-${song.artist}`}
              className="playlist-dropdown-item"
              onMouseDown={() => selectSong(song)}
            >
              <span>{song.name}</span>
              <span>{song.artist}</span>
            </button>
          ))}
        </div>
      </div>
      {selectedSong ? (
        <div className="playlist-selected-chip-row">
          <span className="playlist-selected-chip-label">Selected</span>
          <span className="playlist-selected-chip">
            {formatSongLabel(selectedSong)}
            <button
              type="button"
              className="playlist-selected-chip-remove"
              onClick={() => onSelect(null)}
              aria-label={`Clear ${label.toLowerCase()}`}
            >
              &times;
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PlaylistListItem({
  playlist,
  menuOpen,
  onOpen,
  onMenuToggle,
  onRename,
  onDelete,
}) {
  const title =
    playlist.name ||
    `${formatSongLabel(playlist.startSong)} to ${formatSongLabel(playlist.endSong)}`;
  const startLabel = formatSongLabel(playlist.startSong);
  const endLabel = formatSongLabel(playlist.endSong);

  return (
    <div className={`playlist-row${menuOpen ? " menu-open" : ""}`} onClick={onOpen}>
      <div className="playlist-row-info">
        <h2>{title}</h2>
        <div className="playlist-row-route" aria-label={`${startLabel} to ${endLabel}`}>
          <span className="playlist-song-pill">{startLabel}</span>
          <svg className="playlist-route-arrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h12m-5-5 5 5-5 5" />
          </svg>
          <span className="playlist-song-pill">{endLabel}</span>
        </div>
      </div>
      <div className="playlist-row-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="playlist-menu-button"
          aria-label="Playlist actions"
          onClick={onMenuToggle}
        >
          ...
        </button>
        {menuOpen ? (
          <div className="playlist-menu">
            <button type="button" onClick={onRename}>
              Rename
            </button>
            <button type="button" onClick={onDelete}>
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Playlist() {
  const { playlistId } = useParams();
  const navigate = useNavigate();

  const [user, setUser] = useState(undefined);
  const [playlists, setPlaylists] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [playlistName, setPlaylistName] = useState("");
  const [startSong, setStartSong] = useState(null);
  const [endSong, setEndSong] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [openMenuId, setOpenMenuId] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);

  const [activePlaylist, setActivePlaylist] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [endReached, setEndReached] = useState(false);
  const [ytReady, setYtReady] = useState(false);
  const [loadedPlayerFrameId, setLoadedPlayerFrameId] = useState("");

  const playerRef = useRef(null);
  const playerFrameRef = useRef(null);
  const playerTokenRef = useRef(0);
  const currentIndexRef = useRef(currentIndex);
  const tracksRef = useRef(tracks);
  const goToIndexRef = useRef(null);

  const track = tracks[currentIndex] || null;
  const videoId = track ? getYouTubeId(track.youtubeUrl) : null;
  const playerFrameId =
    playlistId && videoId
      ? `playlist-yt-player-${playlistId}-${currentIndex}-${videoId}`
      : "";
  const selectedSongsMatch = isSameSong(startSong, endSong);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  const destroyPlayer = useCallback(() => {
    playerTokenRef.current += 1;

    if (playerRef.current) {
      try {
        playerRef.current.stopVideo();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser || null);
    });

    return () => unsubscribe();
  }, []);

  const loadPlaylists = useCallback(async () => {
    if (!user) return;

    setListLoading(true);
    setErrorMsg("");
    try {
      const data = await getPlaylists(user.uid);
      setPlaylists(data);
    } catch (err) {
      console.warn("Failed to load playlists:", err);
      setErrorMsg("Could not load your playlists.");
    } finally {
      setListLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user && !playlistId) {
      loadPlaylists();
    }
  }, [loadPlaylists, playlistId, user]);

  useEffect(() => {
    if (playlistId) return;

    destroyPlayer();
    setLoadedPlayerFrameId("");
    setActivePlaylist(null);
    setTracks([]);
    setCurrentIndex(0);
    setEndReached(false);
    setDetailLoading(false);
  }, [destroyPlayer, playlistId]);

  useEffect(() => {
    let mounted = true;

    async function loadDetail() {
      if (!user || !playlistId) return;

      setDetailLoading(true);
      setErrorMsg("");
      setEndReached(false);

      try {
        const [playlist, queue] = await Promise.all([
          getPlaylist(user.uid, playlistId),
          getPlaylistQueue(user.uid, playlistId),
        ]);

        if (!mounted) return;

        if (!playlist || !queue || queue.tracks.length === 0) {
          setActivePlaylist(null);
          setTracks([]);
          setErrorMsg("Playlist not found.");
          return;
        }

        setActivePlaylist(playlist);
        setTracks(queue.tracks);
        setCurrentIndex(
          Math.min(Math.max(queue.currentIndex || 0, 0), queue.tracks.length - 1),
        );
        await touchPlaylistLastListened(user.uid, playlistId);
      } catch (err) {
        if (!mounted) return;
        console.warn("Failed to load playlist:", err);
        setErrorMsg("Could not load this playlist.");
      } finally {
        if (mounted) setDetailLoading(false);
      }
    }

    loadDetail();

    return () => {
      mounted = false;
    };
  }, [playlistId, user]);

  useEffect(() => {
    let mounted = true;

    loadYouTubeApi()
      .then(() => {
        if (mounted) setYtReady(true);
      })
      .catch((err) => console.warn("Failed to initialize YouTube API:", err));

    return () => {
      mounted = false;
    };
  }, []);

  const goToIndex = useCallback(
    async (newIndex) => {
      if (!user || !playlistId || tracksRef.current.length === 0) return;

      const boundedIndex = Math.min(
        Math.max(newIndex, 0),
        tracksRef.current.length - 1,
      );
      setCurrentIndex(boundedIndex);
      setEndReached(false);

      try {
        await Promise.all([
          updatePlaylistQueueIndex(user.uid, playlistId, boundedIndex),
          touchPlaylistLastListened(user.uid, playlistId),
        ]);
      } catch (err) {
        console.warn("Failed to persist playlist position:", err);
      }
    },
    [playlistId, user],
  );

  useEffect(() => {
    goToIndexRef.current = goToIndex;
  }, [goToIndex]);

  useEffect(() => {
    if (
      !playlistId ||
      !videoId ||
      !ytReady ||
      loadedPlayerFrameId !== playerFrameId ||
      !playerFrameRef.current ||
      endReached
    ) {
      return undefined;
    }

    const playerToken = playerTokenRef.current + 1;
    playerTokenRef.current = playerToken;

    const player = new window.YT.Player(playerFrameId, {
      events: {
        onReady: (event) => {
          if (playerToken !== playerTokenRef.current) return;
          event.target.playVideo();
        },
        onStateChange: (event) => {
          if (playerToken !== playerTokenRef.current) return;
          if (event.data !== window.YT.PlayerState.ENDED) return;

          const nextIndex = currentIndexRef.current + 1;
          if (nextIndex < tracksRef.current.length) {
            goToIndexRef.current?.(nextIndex);
            return;
          }

          setEndReached(true);
        },
      },
    });
    playerRef.current = player;

    return () => {
      playerTokenRef.current += 1;
      try {
        player.stopVideo();
      } catch {
        /* ignore */
      }
      if (playerRef.current === player) {
        playerRef.current = null;
      }
    };
  }, [
    endReached,
    loadedPlayerFrameId,
    playerFrameId,
    playlistId,
    videoId,
    ytReady,
  ]);

  useEffect(() => {
    if (!openMenuId) return undefined;

    function handleDocumentMouseDown(event) {
      if (
        event.target instanceof Element &&
        event.target.closest(".playlist-row-actions")
      ) {
        return;
      }
      setOpenMenuId(null);
    }

    document.addEventListener("mousedown", handleDocumentMouseDown);
    return () =>
      document.removeEventListener("mousedown", handleDocumentMouseDown);
  }, [openMenuId]);

  async function handleGeneratePlaylist() {
    if (!user || !startSong || !endSong || generating) return;
    if (isSameSong(startSong, endSong)) {
      setErrorMsg("Choose two different songs to generate a playlist.");
      return;
    }

    setGenerating(true);
    setErrorMsg("");

    try {
      const preferences = await getPreferences(user.uid);
      const response = await fetch("/api/playlists/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startSong,
          endSong,
          preference_matrix:
            preferences?.preference_matrix || preferences?.preference_vector || [],
          avoid_matrix: preferences?.avoid_matrix || preferences?.avoid_vector || [],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!Array.isArray(data.tracks) || data.tracks.length === 0) {
        throw new Error("Playlist generation returned no tracks.");
      }

      const newPlaylistId = await createPlaylistWithQueue(user.uid, {
        name: playlistName,
        startSong,
        endSong,
        tracks: data.tracks,
      });

      setPlaylistName("");
      setStartSong(null);
      setEndSong(null);
      setFormOpen(false);
      navigate(`/playlist/${newPlaylistId}`);
    } catch (err) {
      console.warn("Failed to generate playlist:", err);
      setErrorMsg(err.message || "Could not generate playlist.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleOpenPlaylist(id) {
    if (user) {
      touchPlaylistLastListened(user.uid, id).catch((err) =>
        console.warn("Failed to update playlist timestamp:", err),
      );
    }
    navigate(`/playlist/${id}`);
  }

  function handleRename(playlist) {
    setOpenMenuId(null);
    setErrorMsg("");
    setRenameTarget(playlist);
    setRenameValue(playlist.name || "");
  }

  function handleCancelRename() {
    if (renameSaving) return;
    setRenameTarget(null);
    setRenameValue("");
  }

  async function handleSubmitRename(event) {
    event.preventDefault();
    if (!user || !renameTarget || renameSaving) return;

    setRenameSaving(true);
    setErrorMsg("");
    try {
      await renamePlaylist(user.uid, renameTarget.id, renameValue);
      await loadPlaylists();
      setRenameTarget(null);
      setRenameValue("");
    } catch (err) {
      console.warn("Failed to rename playlist:", err);
      setErrorMsg("Could not rename that playlist.");
    } finally {
      setRenameSaving(false);
    }
  }

  async function handleDelete(playlist) {
    if (!user) return;
    setOpenMenuId(null);

    const confirmed = window.confirm("Delete this playlist from your list?");
    if (!confirmed) return;

    try {
      await softDeletePlaylist(user.uid, playlist.id);
      await loadPlaylists();
    } catch (err) {
      console.warn("Failed to delete playlist:", err);
      setErrorMsg("Could not delete that playlist.");
    }
  }

  function handlePrev() {
    goToIndex(currentIndexRef.current - 1);
  }

  function handleNext() {
    const nextIndex = currentIndexRef.current + 1;
    if (nextIndex >= tracksRef.current.length) {
      setEndReached(true);
      return;
    }
    goToIndex(nextIndex);
  }

  function handleReplay() {
    if (playerRef.current && typeof playerRef.current.seekTo === "function") {
      playerRef.current.seekTo(0, true);
      playerRef.current.playVideo();
    } else if (playerFrameRef.current && videoId) {
      playerFrameRef.current.src = getYouTubeEmbedUrl(videoId);
    }
    setEndReached(false);
  }

  const sidebar = (
    <aside className="nav-sidebar" aria-label="Navigation">
      <div className="app-header__brand">
        <Link to="/"><img src={logo} alt="logo" className="app-header__logo" /></Link>
        <Link to="/" className="app-header__title">SCRAMBLR</Link>
      </div>
      <div className="navs">
        <Link to="/survey" className="nav-link">
          <div title="Update your music preferences">
            <img src={surveyIcon} alt="Survey" />
            Survey
          </div>
        </Link>
        <Link to="/playback" className="nav-link">
          <div title="Freeplay">
            <img src={playbackIcon} alt="Freeplay" />
            Freeplay
          </div>
        </Link>
        <Link to="/playlist" className="nav-link">
          <div title="Your playlists">
            <img src={playlistIcon} alt="Playlist" />
            Playlist
          </div>
        </Link>
        <Link to="/activity" className="nav-link">
          <div title="View your listening activity">
            <img src={historyIcon} alt="Activity" />
            Activity
          </div>
        </Link>
      </div>
      {user ? (
        <div className="profile">
          <span className="profile-email">{user.email}</span>
          <button className="logout-btn" onClick={() => signOut(auth).then(() => navigate('/'))} title="Sign out" aria-label="Sign out">
            <img src={logoutIcon} alt="Sign out" className="logout-icon" />
          </button>
        </div>
      ) : null}
    </aside>
  );

  if (user === undefined) {
    return (
      <div className="page-shell">
        <p className="playlist-loading">Loading...</p>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="page-shell">
        <div className="playlist-auth-error">
          <h2>Not Logged In</h2>
          <p>You must be logged in to create and play custom playlists</p>
          <Link to="/login" className="playlist-auth-link">Go to Login</Link>
        </div>
      </div>
    );
  }

  if (playlistId) {
    if (detailLoading) {
      return (
        <div className="page-shell">
          <div className="page-layout">
            {sidebar}
            <main className="playlist-main"><p className="playlist-loading">Loading playlist...</p></main>
          </div>
        </div>
      );
    }

    if (errorMsg || !activePlaylist || tracks.length === 0 || !track) {
      return (
        <div className="page-shell">
          <div className="page-layout">
            {sidebar}
            <main className="playlist-main">
              <div className="playlist-auth-error" style={{ margin: 'auto' }}>
                <h2>Playlist Unavailable</h2>
                <p>{errorMsg || "This playlist could not be loaded."}</p>
                <Link to="/playlist" className="playlist-auth-link">Back to Playlists</Link>
              </div>
            </main>
          </div>
        </div>
      );
    }

    return (
      <div className="page-shell">
        <div className="playlist-3col">
          {sidebar}

          <main className="playlist-player-main">
            {endReached ? (
              <div className="playlist-end-card">
                <h3>You are at the end of this playlist.</h3>
                <div>
                  <button type="button" onClick={() => goToIndex(0)}>Restart</button>
                </div>
              </div>
            ) : (
              <>
                <div className="playlist-video-container">
                  {videoId ? (
                    <iframe
                      key={videoId}
                      id={playerFrameId}
                      ref={playerFrameRef}
                      title={`${track.title} by ${track.artist}`}
                      src={getYouTubeEmbedUrl(videoId)}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      onLoad={() => setLoadedPlayerFrameId(playerFrameId)}
                    />
                  ) : null}
                </div>
                <h2 className="playlist-now-playing">
                  {track.title} — <span>{track.artist}</span>
                </h2>

                <div className="playlist-controls">
                  <button type="button" className="ctrl-btn" onClick={handlePrev} disabled={currentIndex === 0} title="Previous" aria-label="Previous">
                    <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true">
                      <path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z"/>
                    </svg>
                  </button>
                  <button type="button" className="ctrl-btn ctrl-btn--replay" onClick={handleReplay} title="Replay" aria-label="Replay">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M1 4v6h6"/>
                      <path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
                    </svg>
                  </button>
                  <button type="button" className="ctrl-btn" onClick={handleNext} title="Next" aria-label="Next">
                    <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true">
                      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
                    </svg>
                  </button>
                </div>
              </>
            )}
          </main>

          <aside className="playlist-track-card" aria-label="Playlist tracks">
            <div className="playlist-track-card-header">
              <h1>
                {activePlaylist.name ||
                  `${formatSongLabel(activePlaylist.startSong)} to ${formatSongLabel(activePlaylist.endSong)}`}
              </h1>
              <p>{tracks.length} songs</p>
            </div>
            <div className="playlist-track-list">
              {tracks.map((song, index) => {
                const thumbId = getYouTubeId(song.youtubeUrl);
                return (
                  <button
                    type="button"
                    key={`${song.title}-${song.artist}-${index}`}
                    className={`playlist-track-row${index === currentIndex ? " active" : ""}`}
                    onClick={() => goToIndex(index)}
                  >
                    <img src={`https://img.youtube.com/vi/${thumbId}/default.jpg`} alt="" />
                    <span>
                      <strong>{song.title}</strong>
                      <em>{song.artist}</em>
                    </span>
                  </button>
                );
              })}
            </div>
            <button type="button" className="playlist-back-btn" onClick={() => navigate("/playlist")}>
              Back
            </button>
          </aside>
        </div>
      </div>
    );
  }

  const canGenerate = Boolean(startSong && endSong && !selectedSongsMatch);

  return (
    <div className="page-shell">
      <div className="page-layout">
        {sidebar}
        <main className="playlist-main">
          <div className="playlist-card">
            <header className="playlist-header">
              <div>
                <h1>Custom Playlists</h1>
              </div>
              <button type="button" className="playlist-primary-btn" onClick={() => setFormOpen((open) => !open)}>
                {formOpen ? "Hide Playlist Form" : "Generate New Playlist"}
              </button>
            </header>

            {formOpen ? (
              <section className="playlist-form" aria-label="Generate playlist">
                <div className="playlist-form-guidance">
                  <p className="playlist-form-hint">Start typing, then choose from the dropdown results.</p>
                  <p className="playlist-form-tip">
                    <span aria-hidden="true">💡</span>
                    <strong>Tip:</strong>
                    For the best results, choose songs from two different genres.
                  </p>
                </div>
                <div className="playlist-input-group">
                  <label>Playlist Name</label>
                  <input type="text" value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} placeholder="Optional" autoComplete="off" />
                </div>
                <SongSearchField label="Starting Song" placeholder="Search for a starting song" selectedSong={startSong} onSelect={setStartSong} />
                <SongSearchField label="Ending Song" placeholder="Search for an ending song" selectedSong={endSong} onSelect={setEndSong} />
                {selectedSongsMatch ? (
                  <p className="playlist-field-error">Start and end songs must be different.</p>
                ) : null}
                <button
                  type="button"
                  className={`playlist-generate-btn${!canGenerate ? " disabled" : ""}`}
                  disabled={!canGenerate || generating}
                  onClick={handleGeneratePlaylist}
                >
                  {generating ? "Generating Playlist..." : "Generate Playlist"}
                </button>
              </section>
            ) : null}

            {generating ? (
              <div className="playlist-generating-card">
                <div className="playlist-spinner" aria-hidden="true" />
                <h2>Finding the bridge</h2>
                <p>{BRIDGE_COPY}</p>
              </div>
            ) : null}

            {errorMsg && !playlistId ? <p className="playlist-error">{errorMsg}</p> : null}

            <section className="playlist-list" aria-label="Saved playlists">
              {listLoading ? (
                <p className="playlist-loading">Loading playlists...</p>
              ) : playlists.length === 0 ? (
                <p className="playlist-empty">No playlists yet. Generate one to start listening.</p>
              ) : (
                playlists.map((playlist) => (
                  <PlaylistListItem
                    key={playlist.id}
                    playlist={playlist}
                    menuOpen={openMenuId === playlist.id}
                    onOpen={() => handleOpenPlaylist(playlist.id)}
                    onMenuToggle={() => setOpenMenuId((current) => current === playlist.id ? null : playlist.id)}
                    onRename={() => handleRename(playlist)}
                    onDelete={() => handleDelete(playlist)}
                  />
                ))
              )}
            </section>
          </div>
          {renameTarget ? (
            <div
              className="playlist-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) handleCancelRename();
              }}
            >
              <form
                className="playlist-rename-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Rename playlist"
                onSubmit={handleSubmitRename}
              >
                <div>
                  <h2>Rename Playlist</h2>
                </div>
                <label htmlFor="playlist-rename-input">Playlist Name</label>
                <input
                  id="playlist-rename-input"
                  type="text"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  autoComplete="off"
                  autoFocus
                />
                <div className="playlist-rename-actions">
                  <button
                    type="button"
                    className="playlist-secondary-btn"
                    onClick={handleCancelRename}
                    disabled={renameSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="playlist-primary-btn"
                    disabled={renameSaving}
                  >
                    {renameSaving ? "Saving..." : "Save"}
                  </button>
                </div>
              </form>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

export default Playlist;
