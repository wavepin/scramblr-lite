import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import { useQueue } from "../QueueContext";
import { addToPreferences, getPreferences } from "../userFunctions";
import "./Survey.css";

const GENRE_OVERLAP_ERROR =
  "A genre can only appear in one list. Remove it from either Favorite Genres or Genres to Avoid.";
const SEARCH_DEBOUNCE_MS = 500;
const MIN_SEARCH_CHARS = 2;
const SEARCH_CACHE_MAX_ENTRIES = 100;
const EXTRA_GENRES = [{ name: "country" }];
const searchResultCache = new Map();

function formatSongLabel(song) {
  return song.artist ? `${song.name} — ${song.artist}` : song.name;
}

function formatGenreName(name) {
  if (typeof name !== "string") return "";
  return name
    .trim()
    .toLowerCase()
    .replace(/(^|[\s/-])([a-z])/g, (_, prefix, char) => {
      return `${prefix}${char.toUpperCase()}`;
    });
}

function normalizeGenreName(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function mergeGenreList(genres) {
  const seen = new Set();
  return [...(Array.isArray(genres) ? genres : []), ...EXTRA_GENRES]
    .filter((genre) => genre && typeof genre.name === "string")
    .map((genre) => ({ name: genre.name.trim() }))
    .filter((genre) => {
      const key = normalizeGenreName(genre.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getSearchInputState(value) {
  const hasComma = value.includes(",");

  if (!hasComma) {
    return {
      query: value.trim(),
      segmentIndex: 0,
      hasComma,
    };
  }

  const segments = value.split(",");
  const segmentIndex = segments.findIndex((segment) => segment.trim());

  return {
    query: segmentIndex === -1 ? "" : segments[segmentIndex].trim(),
    segmentIndex,
    hasComma,
  };
}

function removeSearchSegment(value, segmentIndex) {
  if (!value.includes(",") || segmentIndex < 0) return "";

  const segments = value.split(",");
  segments.splice(segmentIndex, 1);

  return segments
    .join(",")
    .replace(/^\s*,+\s*/, "")
    .replace(/\s*,+\s*$/, "")
    .trimStart();
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

function getItemKey(item) {
  const name =
    typeof item?.name === "string" ? item.name.trim().toLowerCase() : "";
  const artist =
    typeof item?.artist === "string" ? item.artist.trim().toLowerCase() : "";

  return artist ? `${name}::${artist}` : name;
}

function hasGenreOverlap(preferredGenres, avoidedGenres) {
  const preferred = new Set(
    preferredGenres.map((genre) => normalizeGenreName(genre.name)),
  );

  return avoidedGenres.some((genre) =>
    preferred.has(normalizeGenreName(genre.name)),
  );
}

function normalizeNamedItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.name === "string" && item.name.trim())
    .map((item) => ({ name: item.name.trim() }));
}

function normalizeSongs(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.name === "string" && item.name.trim())
    .map((item) => ({
      name: item.name.trim(),
      artist:
        typeof item.artist === "string" && item.artist.trim()
          ? item.artist.trim()
          : null,
    }));
}
function RecommendationSpeed({value, setValue}){
  return (
    <div className = "input-group">
      <label>How fast do you want new genres?</label>
      <div className = "speed-options"> 
        {["slow","regular","quick"].map((mode)=>(
          <button
          key = {mode}
          type = "button"
          className = {`speed-btn ${value ===mode ? "active" : ""}`}
          onClick={()=>setValue(mode)}>
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>
    </div>
  )
}
/* ───── Chip list shared component ───── */
function ChipList({ items, displayField, onRemove, isAvoid }) {
  if (items.length === 0) return null;
  return (
    <div className="chip-container">
      {items.map((item, i) => (
        <span
          key={getItemKey(item) || i}
          className={`chip${isAvoid ? " chip-avoid" : ""}`}
        >
          {displayField(item)}
          <button
            type="button"
            className="chip-remove"
            onClick={() => onRemove(i)}
            aria-label="Remove"
          >
            &times;
          </button>
        </span>
      ))}
    </div>
  );
}

/* ───── Search field for songs & artists ───── */
function SearchField({
  label,
  placeholder,
  endpoint,
  displayField,
  items,
  setItems,
}) {
  const [inputVal, setInputVal] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const debounceTimerRef = useRef(null);
  const requestIdRef = useRef(0);
  const searchState = useMemo(
    () => getSearchInputState(inputVal),
    [inputVal],
  );
  const canSearch = searchState.query.length >= MIN_SEARCH_CHARS;
  const hasSearchInput = Boolean(inputVal.trim());

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
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
      const res = await fetch(`${endpoint}?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      const nextResults = Array.isArray(data) ? data : [];
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
  }, [endpoint]);

  useEffect(() => {
    clearTimeout(debounceTimerRef.current);

    if (!open || !hasSearchInput || !canSearch) {
      requestIdRef.current += 1;
      setLoading(false);
      setResults([]);
      setNoResults(false);
      return;
    }

    requestIdRef.current += 1;

    const cacheKey = getSearchCacheKey(endpoint, searchState.query);
    const cachedResults = searchResultCache.get(cacheKey);

    if (cachedResults) {
      setResults(cachedResults);
      setNoResults(cachedResults.length === 0);
      setLoading(false);
      return;
    }

    setLoading(true);
    setResults([]);
    setNoResults(false);

    debounceTimerRef.current = setTimeout(() => {
      search(searchState.query);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(debounceTimerRef.current);
  }, [canSearch, endpoint, hasSearchInput, open, search, searchState.query]);

  function selectItem(item) {
    const isDup = items.some(
      (existing) => getItemKey(existing) === getItemKey(item),
    );
    if (!isDup) setItems((prev) => [...prev, item]);

    const nextInput = searchState.hasComma
      ? removeSearchSegment(inputVal, searchState.segmentIndex)
      : "";

    setResults([]);
    setInputVal(nextInput);
    setOpen(Boolean(nextInput.trim()));
    setNoResults(false);
    setLoading(false);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(debounceTimerRef.current);
      if (canSearch) search(searchState.query);
    }
  }

  const showStartTyping = open && !inputVal.trim();
  const showTooShort =
    open &&
    inputVal.trim() &&
    searchState.query.length > 0 &&
    searchState.query.length < MIN_SEARCH_CHARS;

  return (
    <div className="input-group">
      <label>{label}</label>
      <div className="chip-field" ref={wrapperRef}>
        <input
          type="text"
          value={inputVal}
          onChange={(e) => {
            setInputVal(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
        />
        <div className={`dropdown${open ? " active" : ""}`}>
          {showStartTyping && (
            <div className="dropdown-status">
              Start typing to search.
            </div>
          )}
          {showTooShort && (
            <div className="dropdown-status">
              Type at least {MIN_SEARCH_CHARS} characters.
            </div>
          )}
          {searchState.hasComma && canSearch && (
            <div className="dropdown-status dropdown-hint">
              Choose a match for &quot;{searchState.query}&quot;.
            </div>
          )}
          {loading && <div className="dropdown-status">Searching…</div>}
          {noResults && (
            <div className="dropdown-status">No results found.</div>
          )}
          {results.map((item, i) => (
            <div
              key={i}
              className="dropdown-item"
              onMouseDown={() => selectItem(item)}
            >
              <span>{displayField(item)}</span>
            </div>
          ))}
        </div>
      </div>
      <ChipList
        items={items}
        displayField={displayField}
        onRemove={(i) => setItems((prev) => prev.filter((_, idx) => idx !== i))}
      />
    </div>
  );
}

/* ───── Genre dropdown field ───── */
function GenreDropdown({
  label,
  placeholder,
  allGenres,
  items,
  setItems,
  isAvoid,
}) {
  const [inputVal, setInputVal] = useState("");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filtered = allGenres
    .filter((g) => g.name.toLowerCase().includes(inputVal.trim().toLowerCase()))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

  function selectItem(genre) {
    const isDup = items.some(
      (existing) => existing.name.toLowerCase() === genre.name.toLowerCase(),
    );
    if (!isDup) setItems((prev) => [...prev, genre]);
    setInputVal("");
    setOpen(false);
  }

  return (
    <div className="input-group">
      <label>{label}</label>
      <div className="chip-field" ref={wrapperRef}>
        <input
          type="text"
          className={isAvoid ? "dislike" : ""}
          value={inputVal}
          onChange={(e) => {
            setInputVal(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          autoComplete="off"
        />
        <div className={`dropdown${open ? " active" : ""}`}>
          {allGenres.length === 0 && (
            <div className="dropdown-status">Loading genres…</div>
          )}
          {allGenres.length > 0 && filtered.length === 0 && (
            <div className="dropdown-status">No matching genres.</div>
          )}
          {filtered.map((g, i) => (
            <div
              key={getItemKey(g) || i}
              className="dropdown-item"
              onMouseDown={() => selectItem(g)}
            >
              <span>{formatGenreName(g.name)}</span>
            </div>
          ))}
        </div>
      </div>
      <ChipList
        items={items}
        displayField={(g) => formatGenreName(g.name)}
        onRemove={(i) => setItems((prev) => prev.filter((_, idx) => idx !== i))}
        isAvoid={isAvoid}
      />
    </div>
  );
}

/* ───── Main Survey component ───── */
function Survey() {
  const { setPreferencesData, resetQueueForNewPreferences } = useQueue();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [songs, setSongs] = useState([]);
  const [artists, setArtists] = useState([]);
  const [genres, setGenres] = useState([]);
  const [avoidGenres, setAvoidGenres] = useState([]);
  const [allGenres, setAllGenres] = useState([]);
  const [recommendationSpeed, setRecommendationSpeed] = useState("regular");
  const [submitting, setSubmitting] = useState(false);
  const [loadingPreferences, setLoadingPreferences] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [user, setUser] = useState(undefined);
  const initialPrefsRef = useRef(null); // Stores the "original" state for comparison
  const [existingMatrices, setExistingMatrices] = useState(null); // Stores the loaded matrices
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setLoadingPreferences(Boolean(firebaseUser));
      setUser(firebaseUser || null);
    });

    return () => unsubscribe();
  }, []);

  // Fetch all genres once on mount
  useEffect(() => {
    async function fetchGenres() {
      try {
        const res = await fetch("/api/genres");
        if (!res.ok) throw new Error("Failed to fetch genres");
        const data = await res.json();
        setAllGenres(mergeGenreList(data));
      } catch (err) {
        console.error("Error loading genres:", err);
        setAllGenres(mergeGenreList([]));
      }
    }
    fetchGenres();
  }, []);

  useEffect(() => {
    if (user === undefined) return;

    if (user === null) {
      setSongs([]);
      setArtists([]);
      setGenres([]);
      setAvoidGenres([]);
      setStep(1);
      setLoadingPreferences(false);
      return;
    }

    let isMounted = true;

    async function loadPreferences() {
      setLoadingPreferences(true);
      setErrorMsg("");
      setSongs([]);
      setArtists([]);
      setGenres([]);
      setAvoidGenres([]);
      setStep(1);
      setRecommendationSpeed("");

      try {
        const savedPreferences = await getPreferences(user.uid);
        if (!isMounted || !savedPreferences) return;

        const normalizedSongs = normalizeSongs(savedPreferences.songs);
        const normalizedArtists = normalizeNamedItems(savedPreferences.artists);
        const normalizedGenres = normalizeNamedItems(savedPreferences.genres);
        const normalizedAvoid = normalizeNamedItems(savedPreferences.avoid_genres);
        const speed = savedPreferences.recommendation_speed || "regular";

        setSongs(normalizedSongs);
        setArtists(normalizedArtists);
        setGenres(normalizedGenres);
        setAvoidGenres(normalizedAvoid);
        setRecommendationSpeed(speed)

        setExistingMatrices(
          Array.isArray(savedPreferences.preference_matrix)
            ? {
                preference_matrix: savedPreferences.preference_matrix,
                avoid_matrix: Array.isArray(savedPreferences.avoid_matrix)
                  ? savedPreferences.avoid_matrix
                  : [],
              }
            : null
        );
        
        initialPrefsRef.current = JSON.stringify({
          songs: normalizedSongs,
          artists: normalizedArtists,
          genres: normalizedGenres,
          avoid_genres: normalizedAvoid,
          recommendation_speed: speed
        });
        
      } catch (err) {
        if (!isMounted) return;
        console.error("Error loading survey:", err);
        setErrorMsg(
          "Couldn't load your saved survey. You can still update it.",
        );
      } finally {
        if (isMounted) {
          setLoadingPreferences(false);
        }
      }
    }

    loadPreferences();

    return () => {
      isMounted = false;
    };
  }, [user]);

  useEffect(() => {
    if (
      errorMsg === GENRE_OVERLAP_ERROR &&
      !hasGenreOverlap(genres, avoidGenres)
    ) {
      setErrorMsg("");
    }
  }, [avoidGenres, errorMsg, genres]);

  const allFieldsFilled =
    songs.length > 0 &&
    artists.length > 0 &&
    genres.length > 0 &&
    avoidGenres.length > 0;

  async function handleNext() {
    if (!user) {
      setErrorMsg("You must be logged in to save your survey.");
      return;
    }

    if (!allFieldsFilled) {
      setErrorMsg("Add at least one item to each category before continuing.");
      return;
    }

    if (hasGenreOverlap(genres, avoidGenres)) {
      setErrorMsg(GENRE_OVERLAP_ERROR);
      return;
    }

    setErrorMsg("");
    setSubmitting(true);

    const currentSurveyData = {
      songs: songs.map((s) => ({ name: s.name, artist: s.artist || null })),
      artists: artists.map((a) => ({ name: a.name })),
      genres: genres.map((g) => ({ name: g.name })),
      avoid_genres: avoidGenres.map((g) => ({ name: g.name })),
      recommendation_speed: recommendationSpeed || "regular"
    };

    let matrices = existingMatrices;

    // CHECK IF DATA HAS ACTUALLY CHANGED
    const hasChanged = JSON.stringify(currentSurveyData) !== initialPrefsRef.current;

    try {
      if (hasChanged || !matrices) {
        console.log("Changes detected. Recomputing model...");
        const res = await fetch("/api/process-preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user.uid,
            ...currentSurveyData,
          })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }

        matrices = await res.json();
      }

      const preferenceMatrix = Array.isArray(matrices?.preference_matrix)
        ? matrices.preference_matrix
        : [];

      const avoidMatrix = Array.isArray(matrices?.avoid_matrix)
        ? matrices.avoid_matrix
        : [];

      const newSurveyData = {
        songs: currentSurveyData.songs,
        artists: currentSurveyData.artists,
        genres: currentSurveyData.genres,
        avoid_genres: currentSurveyData.avoid_genres,
        recommendation_speed: currentSurveyData.recommendation_speed,
        preference_matrix: preferenceMatrix,
        avoid_matrix: avoidMatrix,
      };

      await addToPreferences(user.uid, newSurveyData);
      setPreferencesData(newSurveyData);
      await resetQueueForNewPreferences();

      // Update the reference so if they click back and next again, it still knows there are no changes
      initialPrefsRef.current = JSON.stringify(currentSurveyData);
      setExistingMatrices(matrices);
      setStep(2);
    } catch (err) {
      console.error("Error saving survey:", err);
      setErrorMsg(`Something went wrong. Please try again. ${err.message || err}`);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
  }

  function resetSurvey() {
    setErrorMsg("");
    setStep(1);
  }

  const summaryRows = [
    { label: "Songs", items: songs, display: formatSongLabel },
    { label: "Artists", items: artists, display: (a) => a.name },
    { label: "Genres", items: genres, display: (g) => formatGenreName(g.name) },
    {
      label: "Avoiding",
      items: avoidGenres,
      display: (g) => formatGenreName(g.name),
    },
    {label: "Recommendation Speed", items: recommendationSpeed?[recommendationSpeed]: [], display: (r)=>r}
  ].filter((r) => r.items.length > 0);

  if (user === undefined) {
    return (
      <div className="survey-page">
        <div className="survey-container">
          <div className="glass-card">
            <p>Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="survey-auth-error">
        <h2>Not Logged In</h2>
        <p>You must be logged in to start the survey</p>
        <Link to="/login" className="survey-auth-error-link">
          Go to Login
        </Link>
      </div>
    );
  }

  if (loadingPreferences) {
    return (
      <div className="survey-page">
        <div className="survey-container">
          <div className="glass-card">
            <p>Loading your survey...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="survey-page">
      <button className="survey-back-btn" onClick={() => navigate(-1)} aria-label="Go back">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Back
      </button>
      {submitting && (
        <div className="loading-overlay">
          <div className="loading-spinner">
            <div className="spinner"></div>
            <p>Saving your preferences...</p>
          </div>
        </div>
      )}
      <div className="survey-container">
        <form
          className="glass-card"
          onSubmit={(e) => e.preventDefault()}
          noValidate
        >
          {/* ── Step 1: Core Preferences ── */}
          <div className={`step${step === 1 ? " active" : ""}`}>
            <header>
              <h1>Music Taste Survey</h1>
              <p>
                Start typing, then choose from the dropdown results
              </p>
            </header>

            <SearchField
              label="Favorite Songs"
              placeholder="e.g. Bohemian Rhapsody"
              endpoint="/api/search/track"
              displayField={formatSongLabel}
              items={songs}
              setItems={setSongs}
            />

            <SearchField
              label="Favorite Artists"
              placeholder="e.g. Adele"
              endpoint="/api/search/artist"
              displayField={(item) => item.name}
              items={artists}
              setItems={setArtists}
            />

            <GenreDropdown
              label="Favorite Genres"
              placeholder="e.g. Jazz, Indie"
              allGenres={allGenres}
              items={genres}
              setItems={setGenres}
            />

            <GenreDropdown
              label="Genres to Avoid"
              placeholder="e.g. Heavy Metal"
              allGenres={allGenres}
              items={avoidGenres}
              setItems={setAvoidGenres}
              isAvoid
            />
            <RecommendationSpeed
              value = {recommendationSpeed}
              setValue={setRecommendationSpeed}/>


            <button
              type="button"
              className={`submit-btn${!allFieldsFilled ? " btn-greyed" : ""}`}
              disabled={submitting}
              onClick={handleNext}
            >
              {submitting ? "Saving…" : "Next Step →"}
            </button>
            {errorMsg && <p className="error-msg">{errorMsg}</p>}
          </div>

          {/* ── Step 2: Success / Summary ── */}
          <div className={`step${step === 2 ? " active" : ""}`}>
            <header>
              <h1>You're all set!</h1>
              <p>Here's what you picked:</p>
            </header>

            <div id="survey-summary">
              {summaryRows.map((row) => (
                <div className="summary-row" key={row.label}>
                  <span className="summary-label">{row.label}</span>
                  <span className="summary-chips">
                    {row.items.map((item, i) => (
                      <span
                        key={getItemKey(item) || i}
                        className={`chip${row.label === "Avoiding" ? " chip-avoid" : ""}`}
                      >
                        {row.display(item)}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>

            <button
              type="button"
              className="submit-btn"
              onClick={() => navigate("/playback")}
            >
              Continue to Playback
            </button>
            <div className="back-btn" onClick={resetSurvey}>
              ← Edit Survey Preferences
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default Survey;
