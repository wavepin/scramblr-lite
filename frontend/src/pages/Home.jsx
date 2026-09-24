import { useState, useEffect } from "react"
import { useNavigate, Navigate, Link } from "react-router-dom"
import { onAuthStateChanged, signOut } from "firebase/auth"
import { auth } from "../firebase"
import logo from "../assets/scramblr.png"
import logoutIcon from "../assets/logout.png"
import playbackIcon from "../assets/playback.png"
import playlistIcon from "../assets/playlist.png"
import historyIcon from "../assets/listeninghistory.png"
import surveyIcon from "../assets/survey.png"
import roshan from "../assets/roshan.png"
import noah from "../assets/noah.png"
import bruce from "../assets/bruce.png"
import jason from "../assets/jason.png"
import theo from "../assets/theo.png"
import drew from "../assets/drew.png"
import ceren from "../assets/ceren.png"
import "./Home.css"

const MEMBERS = [
    { name: "Roshan", img: roshan },
    { name: "Noah",   img: noah   },
    { name: "Bruce",  img: bruce  },
    { name: "Jason",  img: jason  },
    { name: "Theo",   img: theo   },
    { name: "Drew",   img: drew   },
    { name: "Ceren",  img: ceren  },
]

function Home() {
    const [user, setUser] = useState(undefined)
    const navigate = useNavigate()

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
            setUser(firebaseUser || null)
        })
        return () => unsubscribe()
    }, [])

    if (user === undefined) return null
    if (user === null) return <Navigate to="/" />

    return (
        <div className="home-shell">
            <div className="home-layout">

                {/* ── Left sidebar ── */}
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

                {/* ── Main content ── */}
                <main className="home-main">
                    <div className="orbit-scene">
                        {MEMBERS.map((m, i) => (
                            <div
                                key={m.name}
                                className="orbit-avatar-wrapper"
                                style={{ "--i": i, "--total": MEMBERS.length }}
                            >
                                <img src={m.img} alt={m.name} className="orbit-avatar" title={m.name} />
                            </div>
                        ))}

                        <div className="home-center">
                            <h1 className="home-welcome">Welcome back!</h1>
                            <img src={logo} alt="SCRAMBLR" className="home-logo" />
                        </div>
                    </div>
                </main>

            </div>
        </div>
    )
}

export default Home
