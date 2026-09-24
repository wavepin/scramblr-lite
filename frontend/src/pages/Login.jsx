import { useState, useEffect } from 'react'
import { auth } from '../firebase'
import { onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'
import './Login.css'

function Login() {
    const navigate = useNavigate()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [isSignUp, setIsSignUp] = useState(true)
    const [passwordVisible, setPasswordVisible] = useState(false)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (user) {
                navigate('/home')
            }
        })
        return () => unsubscribe()
    }, [navigate])

    const handleSignUp = async (e) => {
        e.preventDefault()
        setError('')
        setLoading(true)

        try {
            await createUserWithEmailAndPassword(auth, email, password)
            navigate('/survey')
            // User will be redirected by onAuthStateChanged hook
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    const handleLogin = async (e) => {
        e.preventDefault()
        setError('')
        setLoading(true)

        try {
            await signInWithEmailAndPassword(auth, email, password)
            navigate('/home')
            // User will be redirected by onAuthStateChanged hook
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    const handleForgotPassword = async () => {
        if (!email) {
            setError('Enter your email first to reset your password.')
            return
        }

        setError('')
        setLoading(true)

        try {
            await sendPasswordResetEmail(auth, email)
            setError('Password reset email sent. Check your inbox.')
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="login-container">
            <div className="login-card">
                <h1>{isSignUp ? 'Create Account' : 'Login'}</h1>
                
                {error && <div className="error-message">{error}</div>}

                <form onSubmit={isSignUp ? handleSignUp : handleLogin}>
                    <div className="form-group">
                        <label htmlFor="email">Email</label>
                        <input
                            id="email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="Enter your email"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="password">Password</label>
                        <input
                            id="password"
                            type={passwordVisible ? 'text' : 'password'}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Enter your password"
                            required
                        />
                        <button
                            type="button"
                            className="link-button small"
                            onClick={() => setPasswordVisible((prev) => !prev)}
                        >
                            {passwordVisible ? 'Hide password' : 'Show password'}
                        </button>
                    </div>

                    <div className="form-group" style={{ visibility: isSignUp ? 'hidden' : 'visible' }}>
                        <button
                            type="button"
                            className="link-button forgot-password"
                            onClick={handleForgotPassword}
                            disabled={loading || isSignUp}
                        >
                            Forgot password?
                        </button>
                    </div>

                    <button type="submit" disabled={loading}>
                        {loading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Login'}
                    </button>
                </form>

                <div className="toggle-auth">
                    {isSignUp ? (
                        <p>
                            Already have an account?{' '}
                            <button 
                                type="button" 
                                onClick={() => setIsSignUp(false)}
                                className="link-button"
                            >
                                Login
                            </button>
                        </p>
                    ) : (
                        <p>
                            Don't have an account?{' '}
                            <button 
                                type="button" 
                                onClick={() => setIsSignUp(true)}
                                className="link-button"
                            >
                                Sign Up
                            </button>
                        </p>
                    )}
                </div>
            </div>
        </div>
    )
}

export default Login