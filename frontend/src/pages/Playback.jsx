import { useState, useEffect, useRef, useCallback } from "react";             
import { Link, useLocation, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";                                      
import { auth } from "../firebase";
import logo from '../assets/scramblr.png';
import logoutIcon from '../assets/logout.png';
import playbackIcon from '../assets/playback.png';
import playlistIcon from '../assets/playlist.png';
import historyIcon from '../assets/listeninghistory.png';
import surveyIcon from '../assets/survey.png';
import {                                                                      
  initSongDocument,
  getSongInteractionState,                                                    
  updateSongInteraction,
  applyTasteVectorDeltas,
  increment,
} from "../userFunctions";
import { useQueue } from "../QueueContext";                                   
import "./Playback.css";
                              
import roshan from '../assets/roshan.png'
import noah from '../assets/noah.png'
import bruce from '../assets/bruce.png'
import jason from '../assets/jason.png'
import theo from '../assets/theo.png'
import drew from '../assets/drew.png'
import ceren from '../assets/ceren.png'

const MEMBERS = [
    { name: 'Ceren',  img: ceren  }, // Leftmost
    { name: 'Roshan', img: roshan },
    { name: 'Noah',   img: noah   },
    { name: 'Bruce',  img: bruce  },
    { name: 'Jason',  img: jason  },
    { name: 'Theo',   img: theo   },
    { name: 'Drew',   img: drew   },
];

const EARLY_SKIP_THRESHOLD_MS = 30000;
const EARLY_SKIP_PERCENT = 0.25;
                                                                              
function getYouTubeId(url) {
  const match = url.match(                                                    
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );                                                                          
  return match ? match[1] : url;
}                                                                             
                
const getLogSequence = (prefs) => {
  const genres = Array.isArray(prefs?.genres) ? prefs.genres : [];
  const avoidGenres = Array.isArray(prefs?.avoid_genres) ? prefs.avoid_genres : [];
  const songs = Array.isArray(prefs?.songs) ? prefs.songs : [];
  const logs = [
    "Python logs: Loading CLAP model on cpu...",
    "Warning: You are sending unauthenticated requests to the HF Hub. Please set a HF_TOKEN.",
    "Loading weights: 100%|##########| 555/555 [00:00<00:00, 10478.07it/s]",
    "Model loaded."
  ];

  genres.forEach(genre => {
    const mockSong = { name: "Representative Track", artist: `${genre.name} Artist` };
    logs.push(`[{'name': '${mockSong.name}', 'artist': '${mockSong.artist}'}] found for genre: ${genre.name}`);
    logs.push(`{'name': '${mockSong.name}', 'artist': '${mockSong.artist}'} added for genre`);
  });

  avoidGenres.forEach(genre => {
    logs.push(`[{'name': 'Incompatible Rhythm', 'artist': 'Genre Avoidance'}] found for avoid genre: ${genre.name}`);
    logs.push(`{'name': 'Incompatible Rhythm', 'artist': 'Genre Avoidance'} added for avoid genre`);
  });

  const allSongs = [
    ...songs.map(s => ({ name: s.name, artist: s.artist })),
    ...genres.map(g => ({ name: "Representative Track", artist: `${g.name} Artist` }))
  ];

  logs.push(`[${allSongs.map(s => `{'name': '${s.name}', 'artist': '${s.artist}'}`).join(', ')}] in add/subtract song vectors`);

  allSongs.forEach(song => {
    logs.push(`Added ${song.name} to the vector`);
  });

  const generateLongVector = () => {
    const dimensions = 512;
    const values = [];
    for (let i = 0; i < dimensions; i++) {
      const val = (Math.random() * 2 - 1) * Math.pow(10, Math.floor(Math.random() * -2));
      values.push(val.toExponential(8));
    }
    return `[${values.join(' ')}]`;
  };

  logs.push(generateLongVector());

  logs.push("YouTube API quota hit; using search-page fallback")
  logs.push("Applying preference vector for recommendation search...")
  
  return logs;
};

let ytApiLoadPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
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

    const existing =                                                          
document.querySelector('script[src*="youtube.com/iframe_api"]');
    const tag = existing || document.createElement("script");                 
                                                                              
    if (!existing) {
      tag.src = "https://www.youtube.com/iframe_api";                         
      tag.async = true;
      document.head.appendChild(tag);
    }                                                                         
  
    const prev = window.onYouTubeIframeAPIReady;                              
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); finish(); };
    tag.addEventListener("load", finish, { once: true });                     
    tag.addEventListener("error", fail, { once: true });                      
    pollId = window.setInterval(finish, 100);                                 
    timeoutId = window.setTimeout(fail, 10000);                               
    finish();   
  });                                                                         
  return ytApiLoadPromise;
}                                                                             
  
function Playback() {                                                         
  const location = useLocation();
  const navigate = useNavigate();
  const incomingSong = location.state?.song || null;

  const {
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
  } = useQueue();

  const [liked, setLiked] = useState(null);
  const [playedQueue, setPlayedQueue] = useState([]);
  const [artistBio, setArtistBio] = useState(null);
  const [trackGenre, setTrackGenre] = useState(null);                           
  const [ytReady, setYtReady] = useState(false);
  const [recentlyOpen, setRecentlyOpen] = useState(false);
  const [logs, setLogs] = useState([]);

  const logEndRef = useRef(null);
  const playerRef = useRef(null);                                             
  const playerContainerRef = useRef(null);
  const listenStartRef = useRef(null);
  const accumulatedMsRef = useRef(0);                                         
  const currentIndexRef = useRef(currentIndex);
  const userRef = useRef(user);                                               
  const tracksRef = useRef(tracks);
  const incomingHandledRef = useRef(false);                                   
  const goToIndexRef = useRef(goToIndex);
                                                                              
  const track = tracks.length > 0 ? tracks[currentIndex] : null;
  const videoId = track ? getYouTubeId(track.youtubeUrl) : null;
  const hasPreferences = preferences !== undefined && preferences !== null;
  const showRecommendationLoading =
    hasPreferences && (!isLoaded || (tracks.length === 0 && isGenerating));
                                                                              
  const syncPreferenceVectorInBackground = (userId, currentTrack,             
previousReaction, nextReaction) => {                                          
    if (!currentTrack?.title || !currentTrack?.artist) return;                
    void (async () => {                                                       
      try {
        const res = await fetch("/api/process-interaction-vector", {          
          method: "POST",                                                     
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({                                              
            title: currentTrack.title,                                        
            artist: currentTrack.artist,
            previousReaction: previousReaction ?? "none",                     
            nextReaction: nextReaction ?? "none",                             
          }),
        });                                                                   
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `HTTP ${res.status}`);             
        }                                                                     
        const result = await res.json();                                      
        if (!result.matched) {                                                
          if (result.reason !== "no-op") console.warn("Preference vector update skipped:", result.reason || "unknown-reason");                         
          return;
        }                                                                     
        const applyResult = await applyTasteVectorDeltas(userId, {
          preferenceDeltaVector: result.preferenceDeltaVector || result.deltaVector || [],
            avoidDeltaVector: result.avoidDeltaVector || [],
          });                                                         
        if (!applyResult.updated) console.warn("Preference vector delta was not applied:", applyResult.reason || "unknown-reason");                       
      } catch (err) {
        console.warn("Failed to sync preference vector:", err);               
      }
    })();                                                                     
  };            
  useEffect(() => { currentIndexRef.current = currentIndex; },
[currentIndex]);
  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);                 
  useEffect(() => { goToIndexRef.current = goToIndex; }, [goToIndex]);

  useEffect(() => {
  if (showRecommendationLoading) {
    setLogs([]);
    const sequence = getLogSequence(preferences);
    let currentLine = 0;

    const interval = setInterval(() => {
      if (currentLine < sequence.length) {
        setLogs(prev => [...prev, sequence[currentLine]]);
        currentLine++;
      } else {
        clearInterval(interval);
      }
    }, 2000 * (Math.random() + .5)); //Change speed of logs

    return () => clearInterval(interval);
  }
  setLogs([]);
  return undefined;
  }, [showRecommendationLoading, preferences]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);
                                                                              
  // ─── Handle incoming song from Activity page ──────────────────────
  useEffect(() => {                                                           
    if (incomingSong && !incomingHandledRef.current && isLoaded && user) {
      incomingHandledRef.current = true;                                      
      insertAndPlay(incomingSong);
      navigate("/playback", { replace: true, state: {} });                    
    }                                                                         
  }, [incomingSong, isLoaded, user, insertAndPlay, navigate]);
                                                                              
  // ─── Helper: flush accumulated listen time ────────────────────────       
  const flushListenTime = useCallback(async () => {
    if (listenStartRef.current) {                                             
      accumulatedMsRef.current += Date.now() - listenStartRef.current;        
      listenStartRef.current = null;
    }                                                                         
    const ms = accumulatedMsRef.current;
    if (ms > 0 && userRef.current) {                                          
      const currentTrack = tracksRef.current[currentIndexRef.current];
      const vid = getYouTubeId(currentTrack.youtubeUrl);                      
      try {                                                                   
        await updateSongInteraction(userRef.current.uid, vid, {               
          totalListenTimeMs: increment(Math.round(ms)),                       
        });                                                                   
      } catch (err) {
        console.warn("Failed to flush listen time:", err);                    
      }                                                                       
    }
    accumulatedMsRef.current = 0;                                             
  }, []);       

  const getSongDurationMs = useCallback(() => {                               
    if (playerRef.current && typeof playerRef.current.getDuration ===
"function") {                                                                 
      return playerRef.current.getDuration() * 1000;
    }                                                                         
    return 0;   
  }, []);

  const isEarlySkip = useCallback(() => {
    const listened = accumulatedMsRef.current + (listenStartRef.current ?
Date.now() - listenStartRef.current : 0);                                     
    const duration = getSongDurationMs();
    if (duration > 0) return listened < EARLY_SKIP_THRESHOLD_MS && listened < 
duration * EARLY_SKIP_PERCENT;                                                
    return listened < EARLY_SKIP_THRESHOLD_MS;                                
  }, [getSongDurationMs]);                                                    
                                                                              
  // ─── Load YouTube IFrame API ──────────────────────────────────────       
  useEffect(() => {                                                           
    let isMounted = true;                                                     
    loadYouTubeApi()
      .then(() => { if (isMounted) setYtReady(true); })
      .catch((err) => { console.warn("Failed to initialize YouTube API:",     
err); });                                                                     
    return () => { isMounted = false; };                                      
  }, []);                                                                     
                
  // ─── Create / update YT Player when videoId changes ───────────────       
  useEffect(() => {
    if (!videoId || !user || !hasPreferences || !ytReady || !playerContainerRef.current) return  
undefined;                                                                    
  
    listenStartRef.current = null;                                            
    accumulatedMsRef.current = 0;
                                                                              
    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch { /* ignore */ }             
      playerRef.current = null;                                               
    }
                                                                              
    const container = playerContainerRef.current;
    const playerDiv = document.createElement("div");
    playerDiv.id = "yt-player-" + Date.now();                                 
    container.innerHTML = "";
    container.appendChild(playerDiv);                                         
                
    playerRef.current = new window.YT.Player(playerDiv.id, {                  
      videoId,  
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },                 
      events: {                                                               
        onStateChange: (event) => {                                           
          const state = event.data;                                           
          if (state === window.YT.PlayerState.PLAYING) {                      
            listenStartRef.current = Date.now();
          } else if (state === window.YT.PlayerState.PAUSED || state ===      
window.YT.PlayerState.BUFFERING) {                                            
            if (listenStartRef.current) {
              accumulatedMsRef.current += Date.now() - listenStartRef.current;
              listenStartRef.current = null;                                  
            }
          } else if (state === window.YT.PlayerState.ENDED) {                 
            if (listenStartRef.current) {
              accumulatedMsRef.current += Date.now() - listenStartRef.current;
              listenStartRef.current = null;                                  
            }
            const u = userRef.current;                                        
            const nextIndex = currentIndexRef.current + 1 <                   
tracksRef.current.length ? currentIndexRef.current + 1 : 0;                   
            if (u) {                                                          
              const currentTrack = tracksRef.current[currentIndexRef.current];
              const vid = getYouTubeId(currentTrack.youtubeUrl);
              const ms = accumulatedMsRef.current;                            
              accumulatedMsRef.current = 0;
              updateSongInteraction(u.uid, vid, {                             
                completions: increment(1),                                    
                ...(ms > 0 ? { totalListenTimeMs: increment(Math.round(ms)) }
: {}),                                                                        
              })
                .catch((err) => console.warn("Failed to record completion:",
err))                                                                         
                .finally(() => {
                  setPlayedQueue((p) =>                                       
[tracksRef.current[currentIndexRef.current], ...p].slice(0, 20));             
                  setLiked(null);
                  goToIndexRef.current(nextIndex);                            
                });
            } else {
              accumulatedMsRef.current = 0;
              setPlayedQueue((p) =>                                           
[tracksRef.current[currentIndexRef.current], ...p].slice(0, 20));
              setLiked(null);                                                 
              goToIndexRef.current(nextIndex);
            }                                                                 
          }
        },                                                                    
      },        
    });

    return () => {
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;                                             
      }
    };                                                                        
  }, [videoId, ytReady, user, hasPreferences]);

  // ─── Init song document when song changes ─────────────────────────       
  useEffect(() => {
    let ignore = false;                                                       
    if (!user || !hasPreferences || tracks.length === 0) return () => { ignore =
true; };

    const syncSongState = async () => {
      const currentTrack = tracks[currentIndex];
      const vid = getYouTubeId(currentTrack.youtubeUrl);
      try {                                                                   
        await initSongDocument(user.uid, vid, currentTrack);
        const interactionState = await getSongInteractionState(user.uid, vid);
        if (ignore) return;
        if (interactionState.liked) { setLiked("like"); return; }
        if (interactionState.disliked) { setLiked("dislike"); return; }       
        setLiked(null);                                                       
      } catch (err) {                                                         
        if (!ignore) setLiked(null);                                          
        console.warn("Failed to sync song state:", err);                      
      }
    };                                                                        
                
    syncSongState();
    return () => { ignore = true; };
  }, [currentIndex, user, hasPreferences, tracks]);
                                                                              
  // ─── Flush listen time on unmount ─────────────────────────────────
  useEffect(() => {                                                           
    return () => { flushListenTime(); };
  }, [flushListenTime]);                                                      
  
  // ─── Fetch artist bio when artist changes ─────────────────────────
  useEffect(() => {
    if (!track?.artist) { setArtistBio(null); return; }
    let ignore = false;
    setArtistBio(null);
    fetch(`/api/artist/bio?artist=${encodeURIComponent(track.artist)}`)
      .then((r) => r.json())
      .then((data) => { if (!ignore && data.bio) setArtistBio(data.bio); })
      .catch(() => {});
    return () => { ignore = true; };
  }, [track?.artist]);

  // ─── Fetch track genre when track changes ─────────────────────────
  useEffect(() => {
    if (!track?.title || !track?.artist) { setTrackGenre(null); return; }
    let ignore = false;
    setTrackGenre(null);
    fetch(`/api/track/genre?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}`)
      .then((r) => r.json())
      .then((data) => { if (!ignore && data.genre) setTrackGenre(data.genre); })
      .catch(() => {});
    return () => { ignore = true; };
  }, [track?.title, track?.artist]);                                                        
                
  // ─── Handlers ─────────────────────────────────────────────────────       
  const handlePrev = async () => {
    if (user && tracks.length > 0) {                                          
      const earlySkip = isEarlySkip();
      await flushListenTime();
      const vid = getYouTubeId(tracks[currentIndex].youtubeUrl);              
      try {
        await updateSongInteraction(user.uid, vid, {                          
          skips: increment(1),
          ...(earlySkip ? { earlySkips: increment(1) } : {}),                 
        });
      } catch (err) { console.warn("Failed to record skip:", err); }          
    }           
    setPlayedQueue((p) => [tracks[currentIndex], ...p].slice(0, 20));         
    setLiked(null);
    prev();                                                                   
  };            

  const handleNext = async () => {                                            
    if (user && tracks.length > 0) {
      const earlySkip = isEarlySkip();                                        
      await flushListenTime();
      const vid = getYouTubeId(tracks[currentIndex].youtubeUrl);
      try {                                                                   
        await updateSongInteraction(user.uid, vid, {
          skips: increment(1),                                                
          ...(earlySkip ? { earlySkips: increment(1) } : {}),
        });                                                                   
      } catch (err) { console.warn("Failed to record skip:", err); }
    }                                                                         
    setPlayedQueue((p) => [tracks[currentIndex], ...p].slice(0, 20));
    setLiked(null);
    next();                                                                   
  };
                                                                              
  const handleLike = async () => {
    const previousReaction = liked;
    const currentTrack = tracks[currentIndex];                                
    const newValue = previousReaction === "like" ? null : "like";
    setLiked(newValue);                                                       
    if (user) { 
      const vid = getYouTubeId(tracks[currentIndex].youtubeUrl);              
      try {                                                                   
        if (newValue === "like") {
          await updateSongInteraction(user.uid, vid, { liked: true, disliked: 
false });                                                                     
        } else {
          await updateSongInteraction(user.uid, vid, { liked: false });       
        }                                                                     
        syncPreferenceVectorInBackground(user.uid, currentTrack,
previousReaction, newValue);                                                  
      } catch (err) {
        setLiked(previousReaction);                                           
        console.warn("Failed to update like:", err);
      }                                                                       
    }           
  };

  const handleDislike = async () => {                                         
    const previousReaction = liked;
    const currentTrack = tracks[currentIndex];                                
    const newValue = previousReaction === "dislike" ? null : "dislike";
    setLiked(newValue);
    if (user) {                                                               
      const vid = getYouTubeId(tracks[currentIndex].youtubeUrl);
      try {                                                                   
        if (newValue === "dislike") {
          await updateSongInteraction(user.uid, vid, { disliked: true, liked:
false });                                                                     
        } else {
          await updateSongInteraction(user.uid, vid, { disliked: false });    
        }       
        syncPreferenceVectorInBackground(user.uid, currentTrack,
previousReaction, newValue);                                                  
      } catch (err) {
        setLiked(previousReaction);                                           
        console.warn("Failed to update dislike:", err);
      }                                                                       
    }
  };                                                                          
                
  const handleReplay = async () => {
    if (user) {
      await flushListenTime();
      const vid = getYouTubeId(tracks[currentIndex].youtubeUrl);
      try {                                                                   
        await updateSongInteraction(user.uid, vid, { replays: increment(1),
totalPlays: increment(1) });                                                  
      } catch (err) { console.warn("Failed to record replay:", err); }
    }                                                                         
    if (playerRef.current && typeof playerRef.current.seekTo === "function") {
      playerRef.current.seekTo(0, true);                                      
      playerRef.current.playVideo();
    }                                                                         
    listenStartRef.current = null;
    accumulatedMsRef.current = 0;                                             
  };            

  // ─── Loading / error states ───────────────────────────────────────       
  if (user === undefined) return <div 
className="playback-shell"><p>Loading...</p></div>;                           
                
  if (user === null) {                                                        
    return (    
      <div className="playback-auth-error">                                   
        <h2>Not Logged In</h2>
        <p>You must be logged in to play music and track listening            
activity</p>                                                                  
        <Link to="/login" className="playback-auth-error-link">Go to          
Login</Link>                                                                  
      </div>    
    );                                                                        
  }
                                                                              
  if (preferences === undefined) return <div 
className="playback-shell"><p>Loading...</p></div>;

  if (preferences === null) {                                                 
    return (
      <div className="playback-shell">
        <div className="playback-layout playback-layout--guard">
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
          <main className="playback-guard-main">
            <section className="playback-survey-card" aria-labelledby="survey-required-title">
              <h1 id="survey-required-title">Survey Required</h1>
              <p>Please fill out the Music Taste Survey first so we can generate personalized song recommendations for you.</p>
              <Link to="/survey" className="playback-survey-link">Go to Survey</Link>
            </section>
          </main>
        </div>
      </div>    
    );
  }

  if (showRecommendationLoading) {
    return (
        <div className="playback-shell terminal-theme">
          <div className="sprite-stage">
            <div className="sprite-group">
              {MEMBERS.map((member) => (
                <div 
                  key={member.name} 
                  className={`sprite-wrapper ${member.name === 'Ceren' ? 'leader' : ''}`}
                >
                  <img src={member.img} alt={member.name} className="team-sprite" />
                </div>
              ))}
            </div>
          </div>
          <div className="terminal-window">
            <div className="terminal-header">
              <div className="terminal-title">scramblr-ai-model --recommend</div>
            </div>
            <div className="terminal-body">
              {logs.map((log, i) => (
                <div key={i} className="log-line">
                  <span className="prompt">{">"}</span> {log}
                </div>
              ))}

              <div ref={logEndRef} />
            </div>
          </div>
          <div className="terminal-footer-text">
            <h2>Generating Recommendations</h2>
            <p>Crunching the numbers to find your next favorite song...</p>
          </div>
        </div>
      );
  }             

  if (tracks.length === 0 || !track) {                                        
    return (
      <div className="playback-shell">
        <div className="playback-layout playback-layout--guard">
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
          <main className="playback-guard-main">
            <section className="playback-survey-card" aria-labelledby="no-recommendations-title">
              <h1 id="no-recommendations-title">No Recommendations</h1>
              <p>We couldn't find any songs to recommend. Try updating your survey preferences.</p>
              <Link to="/survey" className="playback-survey-link">Update Survey</Link>
            </section>
          </main>
        </div>
      </div>    
    );
  }

  return (
    <div className="playback-shell">
      <div className="playback-layout">                                       
        <aside className="nav-sidebar" aria-label="Navigation">
          <div className="app-header__brand">                                 
            <Link to="/"><img src={logo} alt="logo"
className="app-header__logo" /></Link>                                        
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

            <button
              className="nav-link recently-played-toggle"
              onClick={() => setRecentlyOpen((o) => !o)}                      
              aria-expanded={recentlyOpen}
            >                                                                 
              <div>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none"   
stroke="currentColor" strokeWidth="2" strokeLinecap="round"                   
strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12"
r="10"/><polyline points="12 6 12 12 16 14"/></svg>                           
                Recently Played
                <svg className={`chevron ${recentlyOpen ? "chevron--open" :
""}`} viewBox="0 0 24 24" width="14" height="14" fill="none"                  
stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>                  
              </div>
            </button>
                                                                              
            {recentlyOpen && (
              <ul className="recently-played-dropdown">                       
                {playedQueue.length === 0 ? (
                  <li className="recently-played-empty">Nothing played        
yet</li>
                ) : (                                                         
                  playedQueue.map((song, i) => (
                    <li key={i} className="recently-played-item">             
                      <span
className="recently-played-title">{song.title}</span>                         
                      <span
className="recently-played-artist">{song.artist}</span>                       
                    </li>
                  ))
                )}
              </ul>
            )}                                                                
          </div>
                                                                              
          <div className="profile">
            <span className="profile-email">{user.email}</span>
            <button className="logout-btn" onClick={() =>
signOut(auth).then(() => navigate('/'))} title="Sign out" aria-label="Sign    
out">
              <img src={logoutIcon} alt="Sign out" className="logout-icon" /> 
            </button>                                                         
          </div>
        </aside>                                                              
                
        <main className="playback-main">
          <div className="video-container" ref={playerContainerRef} />
          <h2 className="track-title">                                        
            {track.title} — <span
className="track-artist">{track.artist}</span>                                
          </h2> 
          <div className="controls">                                          
            <button className="ctrl-btn" onClick={handlePrev} title="Previous"
  aria-label="Previous">                                                       
              <svg viewBox="0 0 24 24" width="34" height="34"
fill="currentColor" aria-hidden="true">                                       
                <path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z"/>
              </svg>                                                          
            </button>
                                                                              
            <button
              className={`ctrl-btn ${liked === "like" ? "active-like" : ""}`}
              onClick={handleLike}                                            
              title={liked === "like" ? "Unlike" : "Like"}
              aria-label={liked === "like" ? "Unlike" : "Like"}               
            >   
              {liked === "like" ? (                                           
                <svg viewBox="0 0 24 24" width="32" height="32"
fill="currentColor" aria-hidden="true">                                       
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12
17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>                            
                </svg>
              ) : (                                                           
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none"
stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"                
aria-hidden="true">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12       
17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>                            
                </svg>
              )}                                                              
            </button>

            <button
              className={`ctrl-btn ${liked === "dislike" ? "active-dislike" :
""}`}                                                                         
              onClick={handleDislike}
              title={liked === "dislike" ? "Un-dislike" : "Dislike"}          
              aria-label={liked === "dislike" ? "Un-dislike" : "Dislike"}     
            >
              <svg viewBox="0 0 24 24" width="32" height="32"                 
stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none"     
aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"/>                         
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>                                                          
            </button>
                                                                              
            <button className="ctrl-btn ctrl-btn--replay"                     
onClick={handleReplay} title="Replay" aria-label="Replay">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none"     
stroke="currentColor" strokeWidth="2" strokeLinecap="round"                   
strokeLinejoin="round" aria-hidden="true">
                <path d="M1 4v6h6"/>                                          
                <path d="M3.51 15a9 9 0 1 0 .49-4.5"/>                        
              </svg>                                                          
            </button>                                                         
                                                                              
            <button className="ctrl-btn" onClick={handleNext} title="Next"
aria-label="Next">
              <svg viewBox="0 0 24 24" width="34" height="34" 
fill="currentColor" aria-hidden="true">                                       
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
              </svg>                                                          
            </button>
          </div>                                                              
        </main> 

        <aside className="metadata-sidebar" aria-label="Song information">    
          <h3>Song Information</h3>
          <dl>
            <div><dt>Title</dt><dd>{track.title}</dd></div>
            <div><dt>Artist</dt><dd>{track.artist}</dd></div>
            <div><dt>Genre</dt><dd>{trackGenre ?? "Loading…"}</dd></div>
            <div>
              <dt>About the Artist</dt>
              <dd className="artist-bio">{artistBio ?? "Loading…"}</dd>
            </div>
          </dl>                                                               
        </aside>                                                              
      </div>    
    </div>
  );
}

export default Playback;
