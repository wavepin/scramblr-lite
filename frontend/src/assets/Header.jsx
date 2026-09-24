import { useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { auth } from '../firebase'
import logo from './scramblr.png'
import profileIcon from './gear.png'
import './Header.css'

function Header() {
    const navigate = useNavigate()
    const location = useLocation()
    const menuRef = useRef(null)
    const [openMenuPath, setOpenMenuPath] = useState(null)
    const [user, setUser] = useState(auth.currentUser)
    const menuOpen = openMenuPath === location.pathname

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
            setUser(firebaseUser)
            if (!firebaseUser) {
                setOpenMenuPath(null)
            }
        })

        return () => unsubscribe()
    }, [])

    useEffect(() => {
        function handleClickOutside(event) {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
                setOpenMenuPath(null)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    function handleNavigate(path) {
        setOpenMenuPath(null)
        navigate(path)
    }

    return (
        <header className="app-header">
            <div className="app-header__brand">
                <Link to="/">
                    <img src={logo} alt="logo" className="app-header__logo" />
                </Link>
                <Link to="/" className="app-header__title">SCRAMBLR</Link>
            </div>

            {user ? (
                <div className="app-header__menu" ref={menuRef}>
                    <button
                        type="button"
                        className="app-header__avatar-button"
                        onClick={() =>
                            setOpenMenuPath((currentPath) =>
                                currentPath === location.pathname ? null : location.pathname,
                            )
                        }
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-label="Open profile menu"
                    >
                        <img
                            src={profileIcon}
                            alt="Profile"
                            className="app-header__avatar-image"
                        />
                    </button>

                    {menuOpen ? (
                        <div className="app-header__dropdown" role="menu">
                            <button
                                type="button"
                                className="app-header__dropdown-item"
                                onClick={() => handleNavigate('/playlist')}
                                role="menuitem"
                            >
                                Custom Playlists
                            </button>
                            <button
                                type="button"
                                className="app-header__dropdown-item"
                                onClick={() => handleNavigate('/activity')}
                                role="menuitem"
                            >
                                Listening Activity
                            </button>
                            <button
                                type="button"
                                className="app-header__dropdown-item"
                                onClick={() => handleNavigate('/Playback')}
                                role="menuitem"
                            >
                                Music Player
                            </button>
                            <button
                                type="button"
                                className="app-header__dropdown-item"
                                onClick={() => handleNavigate('/survey')}
                                role="menuitem"
                            >
                                Update Survey
                            </button>
                            <button
                                type="button"
                                className="app-header__dropdown-item app-header__dropdown-item--danger"
                                onClick={() => signOut(auth).then(() => navigate('/')).catch((error) => console.error('Sign out error:', error))}
                                role="menuitem"
                            >
                                Sign-out
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="app-header__menu-spacer" aria-hidden="true" />
            )}
        </header>
    )
}

export default Header
