import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { auth } from '../firebase'
import {
    confirmPasswordReset,
    verifyPasswordResetCode,
} from 'firebase/auth'
import './ResetPassword.css'

function ResetPassword() {
    const [searchParams] = useSearchParams()

    const mode = searchParams.get('mode')
    const oobCode = searchParams.get('oobCode')

    const isResetFlow = mode === 'resetPassword' && Boolean(oobCode)

    const [accountEmail, setAccountEmail] = useState('')

    const [newPassword, setNewPassword] = useState('')
    const [confirmNewPassword, setConfirmNewPassword] = useState('')

    const [loading, setLoading] = useState(false)
    const [message, setMessage] = useState('')
    const [error, setError] = useState('')

    useEffect(() => {
        setError('')
        setMessage('')
        setAccountEmail('')
        setNewPassword('')
        setConfirmNewPassword('')

        if (!isResetFlow) return

        let cancelled = false
        setLoading(true)

        verifyPasswordResetCode(auth, oobCode)
            .then((email) => {
                if (cancelled) return
                setAccountEmail(email)
            })
            .catch((err) => {
                if (cancelled) return
                setError(
                    err?.message ||
                        'Invalid or expired password reset link. Please request a new one.'
                )
            })
            .finally(() => {
                if (cancelled) return
                setLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [isResetFlow, oobCode])

    const handleConfirmReset = async (e) => {
        e.preventDefault()
        setError('')
        setMessage('')

        if (!oobCode) {
            setError('Missing reset code. Please use the link from your email.')
            return
        }

        if (newPassword.length < 6) {
            setError('Password must be at least 6 characters.')
            return
        }

        if (newPassword !== confirmNewPassword) {
            setError('Passwords do not match.')
            return
        }

        setLoading(true)
        try {
            await confirmPasswordReset(auth, oobCode, newPassword)
            setMessage('Password reset successful. You can now log in.')
        } catch (err) {
            setError(
                err?.message ||
                    'Could not reset password. The link may be expired or the password is too weak.'
            )
        } finally {
            setLoading(false)
        }
    }

    // If the email link landed here with a different mode, give a helpful message.
    if (mode && mode !== 'resetPassword') {
        return (
            <div className="reset-password-container">
                <div className="reset-password-card">
                    <h1>Action not supported</h1>
                    <p>
                        This page only handles password reset links. Your link mode was:{' '}
                        <strong>{mode}</strong>
                    </p>
                    <p>
                        <Link to="/login">Go to Login</Link>
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className="reset-password-container">
            <div className="reset-password-card">
                <h1>Reset password</h1>

                {error ? (
                    <p style={{ color: 'crimson' }}>{error}</p>
                ) : null}
                {message ? (
                    <p style={{ color: 'green' }}>{message}</p>
                ) : null}

                {isResetFlow ? (
                    <>
                        <p>
                            Resetting password for: <strong>{accountEmail || '...'}</strong>
                        </p>

                        <form onSubmit={handleConfirmReset}>
                            <div className="reset-password-form-group">
                                <label htmlFor="new-password">New password</label>
                                <input
                                    id="new-password"
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    autoComplete="new-password"
                                    required
                                />
                            </div>

                            <div className="reset-password-form-group">
                                <label htmlFor="confirm-new-password">Confirm new password</label>
                                <input
                                    id="confirm-new-password"
                                    type="password"
                                    value={confirmNewPassword}
                                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                                    autoComplete="new-password"
                                    required
                                />
                            </div>

                            <button
                                className="reset-password-submit"
                                type="submit"
                                disabled={loading}
                            >
                                {loading ? 'Working…' : 'Set new password'}
                            </button>
                        </form>

                        <div className="reset-password-links">
                            <Link to="/login">Go to Login</Link>
                        </div>
                    </>
                ) : (
                    <>
                        <p>
                            This page is for password reset links from email. Please use the
                            link in your inbox to reset your password.
                        </p>

                        <p className="reset-password-links">
                            <Link to="/login">Go to Login</Link>
                        </p>
                    </>
                )}
            </div>
        </div>
    )
}

export default ResetPassword
