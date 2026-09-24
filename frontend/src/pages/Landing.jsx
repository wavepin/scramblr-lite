import { useState, useEffect } from 'react'
import './Landing.css'
import { useNavigate, Navigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '../firebase'
import logo from '../assets/scramblr.png'
import roshan from '../assets/roshan.png'
import noah from '../assets/noah.png'
import bruce from '../assets/bruce.png'
import jason from '../assets/jason.png'
import theo from '../assets/theo.png'
import drew from '../assets/drew.png'
import ceren from '../assets/ceren.png'

const MEMBERS = [
    { name: 'Roshan', img: roshan },
    { name: 'Noah',   img: noah   },
    { name: 'Bruce',  img: bruce  },
    { name: 'Jason',  img: jason  },
    { name: 'Theo',   img: theo   },
    { name: 'Drew',   img: drew   },
    { name: 'Ceren',  img: ceren  },
]

function Landing() {
    const [user, setUser] = useState(undefined)
    const navigate = useNavigate()

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
            setUser(firebaseUser || null)
        })
        return () => unsubscribe()
    }, [])

    if (user === undefined) return null

    if (user) return <Navigate to="/home" />

    return (
        <div className="landing-page">
            <div className="orbit-scene">
                {MEMBERS.map((m, i) => (
                    <div
                        key={m.name}
                        className="orbit-avatar-wrapper"
                        style={{ '--i': i, '--total': MEMBERS.length }}
                    >
                        <img src={m.img} alt={m.name} className="orbit-avatar" title={m.name} />
                    </div>
                ))}

                <div className="landing-center">
                    <h1>Welcome</h1>
                    <img src={logo} className="logo" alt="scrambler logo" />
                    <h2>This is the place to scramble your music taste!</h2>
                    <button onClick={() => navigate('/login')}>
                        Login or Register
                    </button>
                </div>
            </div>
        </div>
    )
}

export default Landing;
