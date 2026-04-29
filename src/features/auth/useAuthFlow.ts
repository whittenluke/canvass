import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { missingSupabaseConfig, supabase } from '../../lib/supabase'
import {
  APPROVED_LOGIN_EMAILS,
  getAuthRedirectUrl,
  hasResetPasswordIntentInUrl,
  isEmailAlreadyRegisteredSignupError,
  isInvalidPasswordSignInError,
} from '../app/utils'

type UseAuthFlowArgs = {
  onSetErrorMessage: (message: string) => void
  onSessionChanged: (nextSession: Session | null) => void
}

export function useAuthFlow({ onSetErrorMessage, onSessionChanged }: UseAuthFlowArgs) {
  const [session, setSession] = useState<Session | null>(null)
  const [authStep, setAuthStep] = useState<'email' | 'email-instructions' | 'password'>('email')
  const [authEmail, setAuthEmail] = useState('')
  const [authPasswordIntent, setAuthPasswordIntent] = useState<'sign_in' | 'create_password'>(
    'create_password',
  )
  const [authPassword, setAuthPassword] = useState('')
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState('')
  const [authPasswordVisible, setAuthPasswordVisible] = useState(false)
  const [authPasswordConfirmVisible, setAuthPasswordConfirmVisible] = useState(false)
  const [resetPasswordDraft, setResetPasswordDraft] = useState('')
  const [resetPasswordConfirmDraft, setResetPasswordConfirmDraft] = useState('')
  const [resetPasswordVisible, setResetPasswordVisible] = useState(false)
  const [resetPasswordConfirmVisible, setResetPasswordConfirmVisible] = useState(false)
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)

  useEffect(() => {
    const initializeAuth = async () => {
      if (!supabase) {
        onSetErrorMessage(missingSupabaseConfig)
        setIsAuthLoading(false)
        return
      }

      const { data, error } = await supabase.auth.getSession()
      if (error) {
        onSetErrorMessage(error.message)
      } else {
        setSession(data.session)
        onSessionChanged(data.session)
      }
      setIsAuthLoading(false)
    }

    void initializeAuth()

    if (!supabase) {
      return
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, currentSession) => {
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && hasResetPasswordIntentInUrl())) {
        setIsPasswordRecovery(true)
      } else if (event === 'SIGNED_OUT') {
        setIsPasswordRecovery(false)
        setAuthStep('email')
        setAuthPassword('')
        setAuthPasswordConfirm('')
        setAuthPasswordVisible(false)
        setAuthPasswordConfirmVisible(false)
        setAuthPasswordIntent('create_password')
        setAuthMessage('')
      }
      setSession(currentSession)
      onSessionChanged(currentSession)
      onSetErrorMessage('')
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [onSessionChanged, onSetErrorMessage])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time URL recovery intent bootstrap */
    if (hasResetPasswordIntentInUrl()) {
      setIsPasswordRecovery(true)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  const canAttemptEmailAuth = async (normalizedEmail: string): Promise<boolean> => {
    if (APPROVED_LOGIN_EMAILS.length > 0 && !APPROVED_LOGIN_EMAILS.includes(normalizedEmail)) return false
    const { data: hasAccess, error: allowError } = await supabase.rpc('can_request_magic_link', {
      target_email: normalizedEmail,
    })
    if (allowError) return false
    if (!hasAccess) return false
    return true
  }

  const signInWithPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      onSetErrorMessage(missingSupabaseConfig)
      return
    }

    const normalizedEmail = authEmail.trim().toLowerCase()
    const password = authPassword
    if (!normalizedEmail) {
      setAuthMessage('Enter your email address.')
      return
    }
    if (!password) {
      setAuthMessage('Enter your password.')
      return
    }
    if (authPasswordIntent === 'create_password') {
      if (password.length < 8) {
        setAuthMessage('Password must be at least 8 characters.')
        return
      }
      if (!authPasswordConfirm) {
        setAuthMessage('Confirm your new password.')
        return
      }
      if (password !== authPasswordConfirm) {
        setAuthMessage('Passwords do not match.')
        return
      }
    }
    setIsAuthSubmitting(true)
    setAuthMessage('')

    const signUpOpts = {
      email: normalizedEmail,
      password,
      options: { emailRedirectTo: getAuthRedirectUrl('/') },
    }

    if (authPasswordIntent === 'sign_in') {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      })
      if (!signInError) {
        setIsAuthSubmitting(false)
        return
      }
      if (signInError.message.toLowerCase().includes('email not confirmed')) {
        setIsAuthSubmitting(false)
        setAuthMessage('Confirm the link in your email first, then sign in here with the same password.')
        return
      }
      if (isInvalidPasswordSignInError(signInError.message)) {
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp(signUpOpts)
        if (!signUpError) {
          setIsAuthSubmitting(false)
          if (signUpData.session) {
            return
          }
          setAuthMessage(
            'Account created. Check your email to confirm, then sign in here with the same password.',
          )
          return
        }
      }
      setIsAuthSubmitting(false)
      setAuthMessage(
        isInvalidPasswordSignInError(signInError.message)
          ? 'Invalid email or password.'
          : (signInError.message ?? 'Could not sign in.'),
      )
      return
    }

    const { data: signUpData, error: signUpError } = await supabase.auth.signUp(signUpOpts)

    if (!signUpError) {
      setIsAuthSubmitting(false)
      if (signUpData.session) {
        return
      }
      setAuthMessage('Account created. Check your email to confirm, then sign in here with the same password.')
      return
    }

    if (isEmailAlreadyRegisteredSignupError(signUpError.message)) {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      })
      setIsAuthSubmitting(false)
      if (signInError) {
        setAuthMessage(
          'This email already has an account. Use Forgot password to reset it, or enter the password you used before.',
        )
        return
      }
      return
    }

    setIsAuthSubmitting(false)
    setAuthMessage(signUpError.message || 'Could not create account.')
  }

  const continueWithEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      onSetErrorMessage(missingSupabaseConfig)
      return
    }

    const normalizedEmail = authEmail.trim().toLowerCase()
    if (!normalizedEmail) {
      setAuthMessage('Enter your email address.')
      return
    }
    setIsAuthSubmitting(true)
    setAuthMessage('')
    const canAttempt = await canAttemptEmailAuth(normalizedEmail)
    if (!canAttempt) {
      setIsAuthSubmitting(false)
      setAuthEmail(normalizedEmail)
      setAuthPassword('')
      setAuthPasswordConfirm('')
      setAuthPasswordVisible(false)
      setAuthPasswordConfirmVisible(false)
      setAuthStep('email-instructions')
      return
    }

    const { data: intentRaw, error: intentError } = await supabase.rpc('access_email_auth_intent', {
      target_email: normalizedEmail,
    })
    const intent = typeof intentRaw === 'string' ? intentRaw.trim() : String(intentRaw ?? '').trim()
    const nextIntent: 'sign_in' | 'create_password' =
      !intentError && intent === 'sign_in' ? 'sign_in' : 'create_password'

    setAuthEmail(normalizedEmail)
    setAuthPassword('')
    setAuthPasswordConfirm('')
    setAuthPasswordVisible(false)
    setAuthPasswordConfirmVisible(false)
    setAuthPasswordIntent(nextIntent)
    setAuthStep('password')
    setIsAuthSubmitting(false)
  }

  const sendPasswordResetEmail = async () => {
    if (!supabase) {
      onSetErrorMessage(missingSupabaseConfig)
      return
    }

    const normalizedEmail = authEmail.trim().toLowerCase()
    if (!normalizedEmail) {
      setAuthMessage('Enter your email address to reset your password.')
      return
    }

    setIsAuthSubmitting(true)
    setAuthMessage('')
    const redirectTo = getAuthRedirectUrl('/?reset_password=1')
    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo })
    setIsAuthSubmitting(false)

    if (error) {
      setAuthMessage('Could not send reset instructions right now. Please try again.')
      return
    }
    setAuthMessage('If this email is registered, check your inbox for the next step.')
  }

  const completePasswordRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) {
      onSetErrorMessage(missingSupabaseConfig)
      return
    }
    const password = resetPasswordDraft
    const confirmPassword = resetPasswordConfirmDraft
    if (!password) {
      setAuthMessage('Enter a new password.')
      return
    }
    if (password.length < 8) {
      setAuthMessage('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setAuthMessage('Passwords do not match.')
      return
    }

    setIsAuthSubmitting(true)
    setAuthMessage('')
    const { error } = await supabase.auth.updateUser({ password })
    setIsAuthSubmitting(false)
    if (error) {
      setAuthMessage(error.message)
      return
    }

    await supabase.auth.signOut()
    setIsPasswordRecovery(false)
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.delete('reset_password')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }
    setResetPasswordDraft('')
    setResetPasswordConfirmDraft('')
    setResetPasswordVisible(false)
    setResetPasswordConfirmVisible(false)
    setAuthPassword('')
    setAuthPasswordConfirm('')
    setAuthPasswordVisible(false)
    setAuthPasswordConfirmVisible(false)
    setAuthPasswordIntent('create_password')
    setAuthStep('email')
    setAuthMessage('Password updated. Sign in with your new password.')
  }

  const signOut = async () => {
    if (!supabase) {
      return
    }
    setAuthStep('email')
    setAuthPassword('')
    setAuthPasswordConfirm('')
    setAuthPasswordVisible(false)
    setAuthPasswordConfirmVisible(false)
    setAuthPasswordIntent('create_password')
    setAuthMessage('')
    await supabase.auth.signOut()
  }

  return {
    session,
    setSession,
    authStep,
    setAuthStep,
    authEmail,
    setAuthEmail,
    authPasswordIntent,
    setAuthPasswordIntent,
    authPassword,
    setAuthPassword,
    authPasswordConfirm,
    setAuthPasswordConfirm,
    authPasswordVisible,
    setAuthPasswordVisible,
    authPasswordConfirmVisible,
    setAuthPasswordConfirmVisible,
    resetPasswordDraft,
    setResetPasswordDraft,
    resetPasswordConfirmDraft,
    setResetPasswordConfirmDraft,
    resetPasswordVisible,
    setResetPasswordVisible,
    resetPasswordConfirmVisible,
    setResetPasswordConfirmVisible,
    isPasswordRecovery,
    setIsPasswordRecovery,
    authMessage,
    setAuthMessage,
    isAuthSubmitting,
    isAuthLoading,
    continueWithEmail,
    signInWithPassword,
    sendPasswordResetEmail,
    completePasswordRecovery,
    signOut,
  }
}
