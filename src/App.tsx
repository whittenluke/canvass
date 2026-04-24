import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet'
import { missingSupabaseConfig, supabase } from './lib/supabase'
import './App.css'

type AddressRow = {
  id: string
  full_address: string
  lat: number
  long: number
  canvassed: boolean
}

type AccessRow = {
  email: string
  role: 'admin' | 'canvasser'
  status: 'pending' | 'active'
}

const RURAL_HALL_CENTER: [number, number] = [36.2413, -80.2937]
const APP_ROLES = new Set(['admin', 'canvasser'])
const APPROVED_LOGIN_EMAILS = (import.meta.env.VITE_ALLOWED_LOGIN_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean)
const AUTH_REDIRECT_OVERRIDE = import.meta.env.VITE_AUTH_REDIRECT_URL?.trim()

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<string>('')
  const [authEmail, setAuthEmail] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [isSendingLink, setIsSendingLink] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)
  const [addresses, setAddresses] = useState<AddressRow[]>([])
  const [isMapLoading, setIsMapLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [accessRows, setAccessRows] = useState<AccessRow[]>([])
  const [isProfilesLoading, setIsProfilesLoading] = useState(false)
  const [accessMessage, setAccessMessage] = useState('')
  const [newProfileEmail, setNewProfileEmail] = useState('')
  const [newProfileRole, setNewProfileRole] = useState<'admin' | 'canvasser'>('canvasser')
  const [editingEmail, setEditingEmail] = useState('')
  const [editingEmailDraft, setEditingEmailDraft] = useState('')
  const [activeAdminView, setActiveAdminView] = useState<'map' | 'access'>('map')
  const validAddresses = useMemo(
    () =>
      addresses.filter(
        (address) =>
          Number.isFinite(address.lat) &&
          Number.isFinite(address.long) &&
          Math.abs(address.lat) <= 90 &&
          Math.abs(address.long) <= 180,
      ),
    [addresses],
  )
  const adminCount = useMemo(
    () => accessRows.filter((entry) => entry.role === 'admin').length,
    [accessRows],
  )
  const buildAccessRows = (
    accessData: { email: string; role: 'admin' | 'canvasser' }[] | null,
    profileData: { email: string; role?: 'admin' | 'canvasser' }[] | null,
  ): AccessRow[] => {
    const byEmail = new Map<string, AccessRow>()
    const profiles = profileData ?? []
    const activeEmails = new Set(profiles.map((row) => row.email.toLowerCase()))

    ;(accessData ?? []).forEach((row) => {
      byEmail.set(row.email.toLowerCase(), {
        email: row.email,
        role: row.role,
        status: (activeEmails.has(row.email.toLowerCase()) ? 'active' : 'pending') as
          | 'active'
          | 'pending',
      })
    })

    profiles.forEach((row) => {
      const key = row.email.toLowerCase()
      if (!byEmail.has(key) && row.role && APP_ROLES.has(row.role)) {
        byEmail.set(key, {
          email: row.email,
          role: row.role,
          status: 'active',
        })
      }
    })

    return Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email))
  }
  const refreshAccessList = async () => {
    if (!supabase || role !== 'admin') {
      return
    }

    setIsProfilesLoading(true)
    const { data: accessData, error: accessError } = await supabase
      .from('user_access')
      .select('email,role')
      .in('role', ['admin', 'canvasser'])
      .order('email', { ascending: true })

    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('email,role')
      .in('role', ['admin', 'canvasser'])

    if (accessError || profileError) {
      setAccessMessage(accessError?.message ?? profileError?.message ?? 'Failed to load access.')
    } else {
      const rows = buildAccessRows(
        (accessData as { email: string; role: 'admin' | 'canvasser' }[] | null) ?? [],
        (profileData as { email: string; role?: 'admin' | 'canvasser' }[] | null) ?? [],
      )
      setAccessRows(rows)
    }
    setIsProfilesLoading(false)
  }

  useEffect(() => {
    const initializeAuth = async () => {
      if (!supabase) {
        setErrorMessage(missingSupabaseConfig)
        setIsAuthLoading(false)
        return
      }

      const { data, error } = await supabase.auth.getSession()
      if (error) {
        setErrorMessage(error.message)
      } else {
        setSession(data.session)
      }
      setIsAuthLoading(false)
    }

    void initializeAuth()

    if (!supabase) {
      return
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession)
      setRole('')
      setAddresses([])
      setIsMapLoading(true)
      setErrorMessage('')
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const fetchProfileRole = async () => {
      if (!supabase || !session?.user) {
        return
      }
      await supabase.rpc('sync_profile_from_access')

      const normalizedEmail = session.user.email?.trim().toLowerCase()
      const userId = session.user.id

      const { data: byId, error: byIdError } = await supabase
        .from('profiles')
        .select('id,email,role')
        .eq('id', userId)
        .maybeSingle()

      if (byIdError) {
        setErrorMessage(byIdError.message)
        return
      }

      let resolvedRole = byId?.role ?? ''

      if (!resolvedRole && normalizedEmail) {
        const { data: byEmail, error: byEmailError } = await supabase
          .from('profiles')
          .select('id,email,role')
          .eq('email', normalizedEmail)
          .maybeSingle()

        if (byEmailError) {
          setErrorMessage(byEmailError.message)
          return
        }

        resolvedRole = byEmail?.role ?? ''
      }

      const nextRole = resolvedRole
      if (!APP_ROLES.has(nextRole)) {
        setErrorMessage(
          `Account is authenticated but not assigned a valid app role yet. Logged in as ${
            normalizedEmail ?? 'unknown email'
          }.`,
        )
      }
      setRole(nextRole)
    }

    void fetchProfileRole()
  }, [session])

  useEffect(() => {
    const fetchAddresses = async () => {
      if (!supabase || !session?.user || !APP_ROLES.has(role)) {
        return
      }

      const { data, error } = await supabase
        .from('addresses')
        .select('id,full_address,lat,long,canvassed')
        .order('full_address', { ascending: true })
        .limit(5000)

      if (error) {
        setErrorMessage(error.message)
      } else {
        setAddresses((data as AddressRow[]) ?? [])
      }

      setIsMapLoading(false)
    }

    void fetchAddresses()
  }, [session, role])

  useEffect(() => {
    void refreshAccessList()
  }, [role, session])

  const centerPoint = useMemo<[number, number]>(() => RURAL_HALL_CENTER, [])

  const toggleCanvassed = async (address: AddressRow) => {
    if (!supabase) {
      setErrorMessage(missingSupabaseConfig)
      return
    }

    if (role !== 'admin') {
      setErrorMessage('Address status edits are admin-only until canvasser geofence logic is added.')
      return
    }

    const nextState = !address.canvassed
    setAddresses((current) =>
      current.map((item) =>
        item.id === address.id ? { ...item, canvassed: nextState } : item,
      ),
    )

    const { error } = await supabase
      .from('addresses')
      .update({ canvassed: nextState })
      .eq('id', address.id)

    if (error) {
      setAddresses((current) =>
        current.map((item) =>
          item.id === address.id ? { ...item, canvassed: address.canvassed } : item,
        ),
      )
      setErrorMessage(error.message)
    }
  }

  const sendMagicLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      setErrorMessage(missingSupabaseConfig)
      return
    }

    const normalizedEmail = authEmail.trim().toLowerCase()
    if (!normalizedEmail) {
      setAuthMessage('Enter an email address to receive a sign-in link.')
      return
    }
    if (
      APPROVED_LOGIN_EMAILS.length > 0 &&
      !APPROVED_LOGIN_EMAILS.includes(normalizedEmail)
    ) {
      setAuthMessage('This email is not approved yet. Ask an admin to add you first.')
      return
    }
    const { data: canRequest, error: allowError } = await supabase.rpc(
      'can_request_magic_link',
      { target_email: normalizedEmail },
    )
    if (allowError) {
      setAuthMessage(allowError.message)
      return
    }
    if (!canRequest) {
      setAuthMessage('This email is not approved yet. Ask an admin to add you first.')
      return
    }

    setIsSendingLink(true)
    setAuthMessage('')
    const isLocalHost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    const defaultRedirect = isLocalHost ? 'http://localhost:8888/' : `${window.location.origin}/`
    const emailRedirectTo = import.meta.env.DEV
      ? 'http://localhost:8888/'
      : AUTH_REDIRECT_OVERRIDE || defaultRedirect
    const { error } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo,
      },
    })
    setIsSendingLink(false)

    if (error) {
      setAuthMessage(error.message)
      return
    }

    setAuthMessage('Check your email for the sign-in link.')
  }

  const signOut = async () => {
    if (!supabase) {
      return
    }
    await supabase.auth.signOut()
  }

  const upsertProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase || role !== 'admin') {
      return
    }

    const email = newProfileEmail.trim().toLowerCase()
    if (!email) {
      setAccessMessage('Email is required.')
      return
    }

    const { error } = await supabase.rpc('admin_set_user_access', {
      target_email: email,
      target_role: newProfileRole,
    })

    if (error) {
      setAccessMessage(error.message)
      return
    }

    setAccessMessage('Access saved. User can now request a magic link with this email.')
    setNewProfileEmail('')

    await refreshAccessList()
  }

  const updateProfileRole = async (targetEmail: string, nextRole: 'admin' | 'canvasser') => {
    if (!supabase || role !== 'admin') {
      return
    }

    const { error } = await supabase.rpc('admin_set_user_access', {
      target_email: targetEmail,
      target_role: nextRole,
    })

    if (error) {
      setAccessMessage(error.message)
      return
    }

    await refreshAccessList()
  }

  const startEditEmail = (currentEmail: string) => {
    setEditingEmail(currentEmail)
    setEditingEmailDraft(currentEmail)
    setAccessMessage('')
  }

  const cancelEditEmail = () => {
    setEditingEmail('')
    setEditingEmailDraft('')
  }

  const saveEditedEmail = async (currentEmail: string) => {
    if (!supabase || role !== 'admin') {
      return
    }

    const nextEmail = editingEmailDraft.trim().toLowerCase()
    if (!nextEmail) {
      setAccessMessage('Email is required.')
      return
    }

    const { error } = await supabase.rpc('admin_update_user_email', {
      old_email: currentEmail.toLowerCase(),
      new_email: nextEmail,
    })

    if (error) {
      setAccessMessage(error.message)
      return
    }

    setAccessMessage('User email updated.')
    cancelEditEmail()
    await refreshAccessList()
  }

  const deleteUserAccess = async (targetEmail: string) => {
    if (!supabase || role !== 'admin') {
      return
    }

    const confirmed = window.confirm(`Delete ${targetEmail} from app access?`)
    if (!confirmed) {
      return
    }

    const { error } = await supabase.rpc('admin_delete_user_access', {
      target_email: targetEmail.toLowerCase(),
    })

    if (error) {
      setAccessMessage(error.message)
      return
    }

    setAccessMessage('User access removed.')
    await refreshAccessList()
  }

  if (isAuthLoading) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Canvass</h1>
          <p>Checking sign-in status...</p>
        </section>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Canvass</h1>
          <p>Sign in with your assigned email address.</p>
          <form className="auth-form" onSubmit={(event) => void sendMagicLink(event)}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              placeholder="you@example.com"
            />
            <button type="submit" disabled={isSendingLink}>
              {isSendingLink ? 'Sending...' : 'Send magic link'}
            </button>
          </form>
          {authMessage && <p className="auth-message">{authMessage}</p>}
          {errorMessage && <p className="error-banner">{errorMessage}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <h1>Canvass</h1>
        <p>
          {isMapLoading
            ? 'Loading addresses...'
            : `${validAddresses.length} addresses loaded · ${role || 'unknown role'}`}
        </p>
        <button type="button" className="signout-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      {role === 'admin' && (
        <nav className="view-nav" aria-label="Admin pages">
          <button
            type="button"
            className={activeAdminView === 'map' ? 'view-tab active' : 'view-tab'}
            onClick={() => setActiveAdminView('map')}
          >
            Map
          </button>
          <button
            type="button"
            className={activeAdminView === 'access' ? 'view-tab active' : 'view-tab'}
            onClick={() => setActiveAdminView('access')}
          >
            Admin Access
          </button>
        </nav>
      )}

      {errorMessage && <p className="error-banner">{errorMessage}</p>}

      {(role !== 'admin' || activeAdminView === 'map') && (
        <section className="map-page">
          <section className="map-panel">
            <MapContainer center={centerPoint} zoom={13} scrollWheelZoom className="map-view">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {validAddresses.map((address) => (
                <CircleMarker
                  key={address.id}
                  center={[address.lat, address.long]}
                  radius={6}
                  pathOptions={{
                    color: address.canvassed ? '#2e7d32' : '#b91c1c',
                    fillColor: address.canvassed ? '#4caf50' : '#ef5350',
                    fillOpacity: 0.9,
                    weight: 1,
                  }}
                >
                  <Popup>
                    <p className="popup-address">{address.full_address}</p>
                    <button
                      type="button"
                      className="status-button"
                      disabled={role !== 'admin'}
                      onClick={() => void toggleCanvassed(address)}
                    >
                      {role === 'admin'
                        ? address.canvassed
                          ? 'Mark uncanvassed'
                          : 'Mark canvassed'
                        : 'Read only (canvasser permissions next phase)'}
                    </button>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </section>
        </section>
      )}
      {role === 'admin' && activeAdminView === 'access' && (
        <section className="admin-panel">
          <h2>Admin Access Panel</h2>
          <p>
            Add by email and set role. Once added here, that user can request a magic link.
          </p>
          <form className="access-form" onSubmit={(event) => void upsertProfile(event)}>
            <input
              type="email"
              placeholder="User email"
              value={newProfileEmail}
              onChange={(event) => setNewProfileEmail(event.target.value)}
            />
            <select
              value={newProfileRole}
              onChange={(event) =>
                setNewProfileRole(event.target.value as 'admin' | 'canvasser')
              }
            >
              <option value="canvasser">canvasser</option>
              <option value="admin">admin</option>
            </select>
            <button type="submit">Save access</button>
          </form>
          {accessMessage && <p className="access-message">{accessMessage}</p>}
          <div className="profiles-table-wrap">
            <table className="profiles-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {isProfilesLoading ? (
                  <tr>
                    <td colSpan={3}>Loading access list...</td>
                  </tr>
                ) : (
                  accessRows.map((entry) => (
                    <tr key={entry.email}>
                      <td>
                        <div className="email-cell">
                          {editingEmail.toLowerCase() === entry.email.toLowerCase() ? (
                            <input
                              className="table-email-input"
                              type="email"
                              value={editingEmailDraft}
                              onChange={(event) => setEditingEmailDraft(event.target.value)}
                            />
                          ) : (
                            <span>{entry.email}</span>
                          )}
                          {editingEmail.toLowerCase() === entry.email.toLowerCase() ? (
                            <>
                              <button
                                type="button"
                                className="icon-btn"
                                onClick={() => void saveEditedEmail(entry.email)}
                                title="Save email"
                                aria-label="Save email"
                              >
                                ✓
                              </button>
                              <button
                                type="button"
                                className="icon-btn"
                                onClick={cancelEditEmail}
                                title="Cancel edit"
                                aria-label="Cancel edit"
                              >
                                ✕
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => startEditEmail(entry.email)}
                              title="Edit email"
                              aria-label="Edit email"
                            >
                              ✎
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-btn danger"
                            disabled={entry.role === 'admin' && adminCount <= 1}
                            onClick={() => void deleteUserAccess(entry.email)}
                            title="Delete user access"
                            aria-label="Delete user access"
                          >
                            🗑
                          </button>
                        </div>
                      </td>
                      <td>
                        <select
                          className="role-select"
                          value={entry.role}
                          onChange={(event) =>
                            void updateProfileRole(
                              entry.email,
                              event.target.value as 'admin' | 'canvasser',
                            )
                          }
                        >
                          <option value="canvasser" disabled={entry.role === 'admin' && adminCount <= 1}>
                            canvasser
                          </option>
                          <option value="admin">admin</option>
                        </select>
                      </td>
                      <td>
                        <span className={`status-pill ${entry.status}`}>{entry.status}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  )
}

export default App
