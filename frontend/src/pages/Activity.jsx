import { useState, useEffect, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "../firebase";
import logo from "../assets/scramblr.png";
import logoutIcon from "../assets/logout.png";
import playbackIcon from "../assets/playback.png";
import playlistIcon from "../assets/playlist.png";
import historyIcon from "../assets/listeninghistory.png";
import surveyIcon from "../assets/survey.png";
import { getListeningHistory } from "../userFunctions";
import "./Activity.css";

const PAGE_SIZE = 10;

function getYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  return match ? match[1] : url;
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Activity() {
  const [user, setUser] = useState(undefined);
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sortOrder, setSortOrder] = useState("desc");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [recentlyOpen, setRecentlyOpen] = useState(false);

  const cursorsRef = useRef([null]);
  const navigate = useNavigate();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser || null);
    });
    return () => unsubscribe();
  }, []);

  const fetchPage = useCallback(
    async (pageNum) => {
      if (!user) return;
      setLoading(true);
      try {
        const cursor = cursorsRef.current[pageNum - 1] || null;
        const result = await getListeningHistory(user.uid, {
          sortDirection: sortOrder,
          filter,
          pageSize: PAGE_SIZE,
          startAfterDoc: cursor,
        });
        setSongs(result.songs);
        setHasMore(result.hasMore);
        if (result.lastDoc) {
          cursorsRef.current[pageNum] = result.lastDoc;
        }
      } catch (err) {
        console.warn("Failed to fetch listening history:", err);
        setSongs([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [user, sortOrder, filter],
  );

  useEffect(() => {
    if (user) {
      cursorsRef.current = [null];
      setPage(1);
    }
  }, [sortOrder, filter, user]);

  useEffect(() => {
    if (user) fetchPage(page);
  }, [page, fetchPage, user]);

  const handleSongClick = (song) => {
    navigate("/playback", {
      state: {
        song: {
          title: song.title,
          artist: song.artist,
          genre: song.genre,
          youtubeUrl: song.youtubeUrl,
        },
      },
    });
  };

  const sidebar = user ? (
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
      <div className="profile">
        <span className="profile-email">{user.email}</span>
        <button className="logout-btn" onClick={() => signOut(auth).then(() => navigate('/'))} title="Sign out" aria-label="Sign out">
          <img src={logoutIcon} alt="Sign out" className="logout-icon" />
        </button>
      </div>
    </aside>
  ) : null;

  if (user === undefined) {
    return (
      <div className="page-shell">
        <p className="activity-loading">Loading...</p>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="page-shell">
        <div className="activity-auth-error">
          <h2>Not Logged In</h2>
          <p>You must be logged in to view your listening activity</p>
          <Link to="/login" className="activity-auth-link">Go to Login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="page-layout">
        {sidebar}
        <main className="activity-main">
          <div className="activity-card">
            <h1>Listening Activity</h1>

            <div className="activity-controls">
              <select className="activity-select" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
                <option value="desc">Newest First</option>
                <option value="asc">Oldest First</option>
              </select>
              <select className="activity-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">All Songs</option>
                <option value="liked">Liked Songs</option>
                <option value="disliked">Disliked Songs</option>
              </select>
            </div>

            {loading ? (
              <p className="activity-loading">Loading songs...</p>
            ) : songs.length === 0 ? (
              <p className="activity-empty">No songs found.</p>
            ) : (
              <>
                <div className="activity-list">
                  {songs.map((song) => {
                    const vid = getYouTubeId(song.youtubeUrl);
                    return (
                      <div key={song.id} className="activity-row" onClick={() => handleSongClick(song)}>
                        <img className="activity-thumb" src={`https://img.youtube.com/vi/${vid}/default.jpg`} alt={song.title} />
                        <div className="activity-info">
                          <p className="activity-title">{song.title}</p>
                          <p className="activity-artist">{song.artist}</p>
                          <div className="activity-meta">
                            <span className="activity-genre">{song.genre}</span>
                            <span className="activity-date">{formatDate(song.lastPlayedAt)}</span>
                          </div>
                        </div>
                        <span className={`activity-reaction ${song.liked === true ? "liked" : song.disliked === true ? "disliked" : "neutral"}`}>
                          {song.liked === true ? "👍" : song.disliked === true ? "👎" : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="activity-pagination">
                  <button className="activity-page-btn" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>Previous</button>
                  <span className="activity-page-indicator">Page {page}</span>
                  <button className="activity-page-btn" onClick={() => setPage((p) => p + 1)} disabled={!hasMore}>Next</button>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default Activity;
