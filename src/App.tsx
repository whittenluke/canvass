import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { CircleMarker, MapContainer, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet-draw'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
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

type ViewportBounds = {
  south: number
  west: number
  north: number
  east: number
  zoom: number
}

type GeofenceRow = {
  id: string
  name: string
  geometry: GeoJSON.Polygon
  assigned_email: string | null
}

type GeofenceProgress = {
  total: number
  canvassed: number
  remaining: number
}

const RURAL_HALL_CENTER: [number, number] = [36.2413, -80.2937]
const APP_ROLES = new Set(['admin', 'canvasser'])
const VIEWPORT_LIMIT = 4000
const DOTS_VISIBLE_MIN_ZOOM = 15
const APPROVED_LOGIN_EMAILS = (import.meta.env.VITE_ALLOWED_LOGIN_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean)
const AUTH_REDIRECT_OVERRIDE = import.meta.env.VITE_AUTH_REDIRECT_URL?.trim()

function MapViewportWatcher({
  onViewportChange,
}: {
  onViewportChange: (nextViewport: ViewportBounds) => void
}) {
  const map = useMapEvents({
    moveend: () => {
      const bounds = map.getBounds()
      onViewportChange({
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
        zoom: map.getZoom(),
      })
    },
    zoomend: () => {
      const bounds = map.getBounds()
      onViewportChange({
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
        zoom: map.getZoom(),
      })
    },
  })

  useEffect(() => {
    const bounds = map.getBounds()
    onViewportChange({
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
      zoom: map.getZoom(),
    })
  }, [map, onViewportChange])

  return null
}

function MapPaneSetup() {
  const map = useMap()

  useEffect(() => {
    const geofencePane = map.getPane('geofencePane') ?? map.createPane('geofencePane')
    geofencePane.style.zIndex = '350'

    const addressPane = map.getPane('addressPane') ?? map.createPane('addressPane')
    addressPane.style.zIndex = '450'
  }, [map])

  return null
}

function GeofenceDrawManager({
  geofences,
  enabled,
  selectedGeofenceId,
  onCreated,
  onEdited,
  onDeleted,
  onSelect,
}: {
  geofences: GeofenceRow[]
  enabled: boolean
  selectedGeofenceId: string
  onCreated: (geometry: GeoJSON.Polygon) => void
  onEdited: (updates: Array<{ id: string; geometry: GeoJSON.Polygon }>) => void
  onDeleted: (ids: string[]) => void | Promise<boolean>
  onSelect: (id: string) => void
}) {
  const map = useMap()
  const featureGroupRef = useRef<L.FeatureGroup | null>(null)
  const drawControlRef = useRef<L.Control.Draw | null>(null)

  useEffect(() => {
    if (!featureGroupRef.current) {
      featureGroupRef.current = new L.FeatureGroup()
      map.addLayer(featureGroupRef.current)
    }

    const group = featureGroupRef.current
    group.clearLayers()
    geofences.forEach((fence) => {
      const layer = L.polygon(
        fence.geometry.coordinates[0].map(([lng, lat]) => [lat, lng] as [number, number]),
        {
          pane: 'geofencePane',
          color: fence.id === selectedGeofenceId ? '#2563eb' : '#334155',
          weight: fence.id === selectedGeofenceId ? 3 : 2,
          fillColor: fence.id === selectedGeofenceId ? '#93c5fd' : '#94a3b8',
          fillOpacity: fence.id === selectedGeofenceId ? 0.2 : 0.1,
        },
      ) as L.Polygon & { geofenceId?: string }
      layer.geofenceId = fence.id
      layer.on('click', () => onSelect(fence.id))
      group.addLayer(layer)
    })
  }, [map, geofences, selectedGeofenceId, onSelect])

  useEffect(() => {
    if (!featureGroupRef.current) return
    if (enabled && !drawControlRef.current) {
      drawControlRef.current = new L.Control.Draw({
        draw: {
          polygon: {},
          rectangle: false,
          polyline: false,
          marker: false,
          circle: false,
          circlemarker: false,
        },
        edit: {
          featureGroup: featureGroupRef.current,
        },
      })
      map.addControl(drawControlRef.current)
    }
    if (!enabled && drawControlRef.current) {
      map.removeControl(drawControlRef.current)
      drawControlRef.current = null
    }
  }, [map, enabled])

  useEffect(() => {
    const handleCreated = (event: L.DrawEvents.Created) => {
      const layer = event.layer as L.Polygon
      const geometry = (layer.toGeoJSON() as GeoJSON.Feature<GeoJSON.Polygon>).geometry
      onCreated(geometry)
    }
    const handleEdited = (event: L.DrawEvents.Edited) => {
      const updates: Array<{ id: string; geometry: GeoJSON.Polygon }> = []
      event.layers.eachLayer((layer) => {
        const polygon = layer as L.Polygon & { geofenceId?: string }
        if (!polygon.geofenceId) return
        const geometry = (polygon.toGeoJSON() as GeoJSON.Feature<GeoJSON.Polygon>).geometry
        updates.push({ id: polygon.geofenceId, geometry })
      })
      if (updates.length > 0) onEdited(updates)
    }
    const handleDeleted = (event: L.DrawEvents.Deleted) => {
      const ids: string[] = []
      event.layers.eachLayer((layer) => {
        const polygon = layer as L.Polygon & { geofenceId?: string }
        if (polygon.geofenceId) ids.push(polygon.geofenceId)
      })
      if (ids.length > 0) onDeleted(ids)
    }

    map.on(L.Draw.Event.CREATED, handleCreated)
    map.on(L.Draw.Event.EDITED, handleEdited)
    map.on(L.Draw.Event.DELETED, handleDeleted)
    return () => {
      map.off(L.Draw.Event.CREATED, handleCreated)
      map.off(L.Draw.Event.EDITED, handleEdited)
      map.off(L.Draw.Event.DELETED, handleDeleted)
    }
  }, [map, onCreated, onEdited, onDeleted])

  return null
}

function GeofenceTrashIcon() {
  return (
    <svg
      className="geofence-trash-svg"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

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
  const [fetchedAddressCount, setFetchedAddressCount] = useState(0)
  const [viewport, setViewport] = useState<ViewportBounds | null>(null)
  const [hitViewportLimit, setHitViewportLimit] = useState(false)
  const [accessRows, setAccessRows] = useState<AccessRow[]>([])
  const [isProfilesLoading, setIsProfilesLoading] = useState(false)
  const [accessMessage, setAccessMessage] = useState('')
  const [newProfileEmail, setNewProfileEmail] = useState('')
  const [newProfileRole, setNewProfileRole] = useState<'admin' | 'canvasser'>('canvasser')
  const [editingEmail, setEditingEmail] = useState('')
  const [editingEmailDraft, setEditingEmailDraft] = useState('')
  const [activeAdminView, setActiveAdminView] = useState<'map' | 'access'>('map')
  const [geofences, setGeofences] = useState<GeofenceRow[]>([])
  const [selectedGeofenceId, setSelectedGeofenceId] = useState('')
  const [geofenceNameDraft, setGeofenceNameDraft] = useState('')
  const [geofenceEmailDraft, setGeofenceEmailDraft] = useState('')
  const [geofenceProgress, setGeofenceProgress] = useState<GeofenceProgress | null>(null)
  const [isGeofenceProgressLoading, setIsGeofenceProgressLoading] = useState(false)
  const [geofenceMessage, setGeofenceMessage] = useState('')
  const [geofenceDeleteConfirmId, setGeofenceDeleteConfirmId] = useState<string | null>(null)
  const [isGeofenceDeleting, setIsGeofenceDeleting] = useState(false)
  const [dotsEnabled, setDotsEnabled] = useState(true)
  const selectedGeofence = useMemo(
    () => geofences.find((fence) => fence.id === selectedGeofenceId) ?? null,
    [geofences, selectedGeofenceId],
  )
  const geofenceCompletionPercent = useMemo(() => {
    if (!geofenceProgress || geofenceProgress.total === 0) return 0
    return Math.round((geofenceProgress.canvassed / geofenceProgress.total) * 100)
  }, [geofenceProgress])
  const geofenceDisplayNameForDelete = useMemo(() => {
    if (!selectedGeofence) return ''
    const trimmed = geofenceNameDraft.trim()
    return trimmed || selectedGeofence.name || 'Unnamed geofence'
  }, [geofenceNameDraft, selectedGeofence])
  const showGeofenceDeleteDialog = Boolean(
    geofenceDeleteConfirmId &&
      geofenceDeleteConfirmId === selectedGeofenceId &&
      selectedGeofence,
  )
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
  const filteredOutCount = fetchedAddressCount - validAddresses.length
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
      if (!supabase || !session?.user || !APP_ROLES.has(role) || !viewport) {
        return
      }

      setIsMapLoading(true)
      const { data, error, count } = await supabase
        .from('addresses')
        .select('id,full_address,lat,long,canvassed', { count: 'exact' })
        .gte('lat', viewport.south)
        .lte('lat', viewport.north)
        .gte('long', viewport.west)
        .lte('long', viewport.east)
        .limit(VIEWPORT_LIMIT)

      if (error) {
        setErrorMessage(error.message)
        setAddresses([])
        setFetchedAddressCount(0)
        setHitViewportLimit(false)
      } else {
        const rows = (data as AddressRow[]) ?? []
        const matchedCount = count ?? rows.length
        setFetchedAddressCount(matchedCount)
        setHitViewportLimit(matchedCount > rows.length)
        setAddresses(rows)
      }

      setIsMapLoading(false)
    }

    const timer = window.setTimeout(() => {
      void fetchAddresses()
    }, 220)
    return () => window.clearTimeout(timer)
  }, [session, role, viewport])

  useEffect(() => {
    void refreshAccessList()
  }, [role, session])

  useEffect(() => {
    const fetchGeofences = async () => {
      if (!supabase || !session?.user || !APP_ROLES.has(role)) return
      const { data, error } = await supabase
        .from('geofences')
        .select('id,name,geometry,assigned_email')
        .order('created_at', { ascending: true })
      if (error) {
        setGeofenceMessage(error.message)
        return
      }
      setGeofences((data as GeofenceRow[]) ?? [])
    }
    void fetchGeofences()
  }, [session, role])

  useEffect(() => {
    if (!selectedGeofence) {
      setGeofenceProgress(null)
      return
    }
    setGeofenceNameDraft(selectedGeofence.name)
    setGeofenceEmailDraft(selectedGeofence.assigned_email ?? '')
  }, [selectedGeofenceId, selectedGeofence?.name, selectedGeofence?.assigned_email])

  useEffect(() => {
    const computeProgress = async () => {
      if (!supabase || !selectedGeofence) {
        setGeofenceProgress(null)
        return
      }
      const coords = selectedGeofence.geometry.coordinates[0] ?? []
      if (coords.length === 0) {
        setGeofenceProgress({ total: 0, canvassed: 0, remaining: 0 })
        return
      }
      setIsGeofenceProgressLoading(true)
      const lngs = coords.map(([lng]) => lng)
      const lats = coords.map(([, lat]) => lat)
      const minLng = Math.min(...lngs)
      const maxLng = Math.max(...lngs)
      const minLat = Math.min(...lats)
      const maxLat = Math.max(...lats)

      let from = 0
      const pageSize = 1000
      let total = 0
      let canvassed = 0
      let done = false
      while (!done) {
        const { data, error } = await supabase
          .from('addresses')
          .select('lat,long,canvassed')
          .gte('lat', minLat)
          .lte('lat', maxLat)
          .gte('long', minLng)
          .lte('long', maxLng)
          .range(from, from + pageSize - 1)
        if (error) {
          setGeofenceMessage(error.message)
          break
        }
        const rows = (data as Array<{ lat: number; long: number; canvassed: boolean }>) ?? []
        rows.forEach((row) => {
          if (booleanPointInPolygon(point([row.long, row.lat]), selectedGeofence.geometry)) {
            total += 1
            if (row.canvassed) canvassed += 1
          }
        })
        if (rows.length < pageSize) done = true
        else from += pageSize
      }
      setGeofenceProgress({ total, canvassed, remaining: Math.max(total - canvassed, 0) })
      setIsGeofenceProgressLoading(false)
    }
    void computeProgress()
  }, [selectedGeofenceId])

  useEffect(() => {
    if (!showGeofenceDeleteDialog) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isGeofenceDeleting) {
        event.preventDefault()
        setGeofenceDeleteConfirmId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showGeofenceDeleteDialog, isGeofenceDeleting])

  const centerPoint = useMemo<[number, number]>(() => RURAL_HALL_CENTER, [])
  const isCloseZoom = (viewport?.zoom ?? 13) >= 17
  const showAddressDots = dotsEnabled && (viewport?.zoom ?? 13) >= DOTS_VISIBLE_MIN_ZOOM

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
    const addressIsInsideSelectedGeofence =
      !!selectedGeofence &&
      booleanPointInPolygon(point([address.long, address.lat]), selectedGeofence.geometry)

    if (addressIsInsideSelectedGeofence) {
      setGeofenceProgress((current) => {
        if (!current) return current
        const nextCanvassed = current.canvassed + (nextState ? 1 : -1)
        return {
          ...current,
          canvassed: Math.max(0, nextCanvassed),
          remaining: Math.max(current.total - Math.max(0, nextCanvassed), 0),
        }
      })
    }

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
      if (addressIsInsideSelectedGeofence) {
        setGeofenceProgress((current) => {
          if (!current) return current
          const revertedCanvassed = current.canvassed + (address.canvassed ? 1 : -1)
          return {
            ...current,
            canvassed: Math.max(0, revertedCanvassed),
            remaining: Math.max(current.total - Math.max(0, revertedCanvassed), 0),
          }
        })
      }
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

  const handleGeofenceCreated = async (geometry: GeoJSON.Polygon) => {
    if (!supabase || role !== 'admin') return
    const { data, error } = await supabase
      .from('geofences')
      .insert({
        name: 'New geofence',
        geometry,
        assigned_email: null,
      })
      .select('id,name,geometry,assigned_email')
      .single()
    if (error) {
      setGeofenceMessage(error.message)
      return
    }
    const next = data as GeofenceRow
    setGeofences((current) => [...current, next])
    setGeofenceDeleteConfirmId(null)
    setSelectedGeofenceId(next.id)
  }

  const handleGeofenceEdited = async (
    updates: Array<{ id: string; geometry: GeoJSON.Polygon }>,
  ) => {
    if (!supabase || role !== 'admin') return
    for (const update of updates) {
      const { error } = await supabase
        .from('geofences')
        .update({ geometry: update.geometry })
        .eq('id', update.id)
      if (error) {
        setGeofenceMessage(error.message)
        return
      }
    }
    setGeofences((current) =>
      current.map((fence) => {
        const changed = updates.find((item) => item.id === fence.id)
        return changed ? { ...fence, geometry: changed.geometry } : fence
      }),
    )
  }

  const handleGeofenceDeleted = async (ids: string[]): Promise<boolean> => {
    if (!supabase || role !== 'admin') return false
    const { error } = await supabase.from('geofences').delete().in('id', ids)
    if (error) {
      setGeofenceMessage(error.message)
      return false
    }
    setGeofenceDeleteConfirmId((current) => (current && ids.includes(current) ? null : current))
    setGeofences((current) => current.filter((fence) => !ids.includes(fence.id)))
    if (ids.includes(selectedGeofenceId)) {
      setSelectedGeofenceId('')
      setGeofenceProgress(null)
    }
    return true
  }

  const saveSelectedGeofence = async () => {
    if (!supabase || !selectedGeofenceId || role !== 'admin') return
    const name = geofenceNameDraft.trim() || 'Unnamed geofence'
    const assignedEmail = geofenceEmailDraft.trim().toLowerCase() || null
    const { error } = await supabase
      .from('geofences')
      .update({ name, assigned_email: assignedEmail })
      .eq('id', selectedGeofenceId)
    if (error) {
      setGeofenceMessage(error.message)
      return
    }
    setGeofences((current) =>
      current.map((fence) =>
        fence.id === selectedGeofenceId ? { ...fence, name, assigned_email: assignedEmail } : fence,
      ),
    )
    setGeofenceMessage('Geofence details saved.')
  }

  const confirmGeofenceDelete = async () => {
    if (!selectedGeofenceId || role !== 'admin') return
    setIsGeofenceDeleting(true)
    const id = selectedGeofenceId
    const ok = await handleGeofenceDeleted([id])
    setIsGeofenceDeleting(false)
    if (ok) {
      setGeofenceNameDraft('')
      setGeofenceEmailDraft('')
      setGeofenceMessage('Geofence deleted.')
    }
  }

  const selectGeofenceId = (id: string) => {
    setGeofenceDeleteConfirmId(null)
    setSelectedGeofenceId(id)
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
            : `${validAddresses.length} rendered in view (${fetchedAddressCount} matched, ${filteredOutCount} filtered) · ${role || 'unknown role'}`}
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
            onClick={() => {
              setGeofenceDeleteConfirmId(null)
              setActiveAdminView('access')
            }}
          >
            Admin Access
          </button>
        </nav>
      )}

      {errorMessage && <p className="error-banner">{errorMessage}</p>}

      {(role !== 'admin' || activeAdminView === 'map') && (
        <section className="map-page">
          <div className="map-status-line">
            {!dotsEnabled ? (
              <p className="map-status-text">Address dots are hidden. Use "Show dots" to re-enable.</p>
            ) : !showAddressDots ? (
              <p className="map-status-text">Zoom to see address dots.</p>
            ) : hitViewportLimit ? (
              <p className="map-status-text">
                Too many points in this view; showing first {VIEWPORT_LIMIT}. Zoom in for full detail.
              </p>
            ) : (
              <p className="map-status-text muted">Map ready.</p>
            )}
          </div>
          <section className="map-panel">
            <MapContainer center={centerPoint} zoom={13} scrollWheelZoom className="map-view">
              <MapPaneSetup />
              {selectedGeofence && (
                <div className="selected-geofence-chip">
                  Selected: {selectedGeofence.name}
                  {selectedGeofence.assigned_email ? ` (${selectedGeofence.assigned_email})` : ''}
                </div>
              )}
              <button
                type="button"
                className="map-icon-control"
                title={dotsEnabled ? 'Hide address dots' : 'Show address dots'}
                aria-label={dotsEnabled ? 'Hide address dots' : 'Show address dots'}
                onClick={() => setDotsEnabled((current) => !current)}
              >
                {dotsEnabled ? '◉' : '○'}
              </button>
              <MapViewportWatcher onViewportChange={setViewport} />
              <GeofenceDrawManager
                geofences={geofences}
                enabled={role === 'admin'}
                selectedGeofenceId={selectedGeofenceId}
                onCreated={handleGeofenceCreated}
                onEdited={handleGeofenceEdited}
                onDeleted={handleGeofenceDeleted}
                onSelect={selectGeofenceId}
              />
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {showAddressDots &&
                validAddresses.map((address) => (
                <Fragment key={`${address.id}-group`}>
                  {address.canvassed && (
                    <CircleMarker
                      key={`${address.id}-halo`}
                      center={[address.lat, address.long]}
                      pane="addressPane"
                      radius={isCloseZoom ? 20 : 13}
                      interactive={false}
                      pathOptions={{
                        color: '#1d4ed8',
                        fillColor: '#60a5fa',
                        fillOpacity: 0.2,
                        weight: 2,
                      }}
                    />
                  )}
                  <CircleMarker
                    key={address.id}
                    center={[address.lat, address.long]}
                    pane="addressPane"
                    radius={address.canvassed ? 8 : 7}
                    pathOptions={{
                      color: address.canvassed ? '#ffffff' : '#7f1d1d',
                      fillColor: address.canvassed ? '#2563eb' : '#dc2626',
                      fillOpacity: 1,
                      weight: address.canvassed ? 3 : 2,
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
                </Fragment>
              ))}
            </MapContainer>
          </section>
          {role === 'admin' && (
            <aside className="geofence-panel">
              <div className="geofence-panel-header">
                <h3>Geofence Details</h3>
                {selectedGeofence ? (
                  <button
                    type="button"
                    className="geofence-delete-icon"
                    aria-label={`Delete geofence ${geofenceDisplayNameForDelete}`}
                    onClick={() => setGeofenceDeleteConfirmId(selectedGeofenceId)}
                  >
                    <GeofenceTrashIcon />
                  </button>
                ) : null}
              </div>
              {selectedGeofence ? (
                <>
                  <label>
                    Name
                    <input
                      type="text"
                      value={geofenceNameDraft}
                      onChange={(event) => setGeofenceNameDraft(event.target.value)}
                    />
                  </label>
                  <label>
                    Assigned email
                    <input
                      type="email"
                      value={geofenceEmailDraft}
                      onChange={(event) => setGeofenceEmailDraft(event.target.value)}
                      placeholder="canvasser@example.com"
                    />
                  </label>
                  <div className="geofence-save-row">
                    <button type="button" className="status-button" onClick={() => void saveSelectedGeofence()}>
                      Save geofence
                    </button>
                  </div>
                  <div className="geofence-progress">
                    {isGeofenceProgressLoading ? (
                      <p>Loading progress...</p>
                    ) : geofenceProgress ? (
                      <>
                        <div className="progress-summary">
                          <div className="progress-headline">
                            <span>Complete</span>
                            <strong>{geofenceCompletionPercent}%</strong>
                          </div>
                          <div className="progress-bar-track" aria-hidden="true">
                            <div
                              className="progress-bar-fill"
                              style={{ width: `${geofenceCompletionPercent}%` }}
                            />
                          </div>
                        </div>
                        <div className="metric-grid compact">
                          <div className="metric-card emphasis">
                            <span>Remaining</span>
                            <strong>{geofenceProgress.remaining}</strong>
                          </div>
                          <div className="metric-card">
                            <span>Done</span>
                            <strong>{geofenceProgress.canvassed}</strong>
                          </div>
                          <div className="metric-card">
                            <span>Total</span>
                            <strong>{geofenceProgress.total}</strong>
                          </div>
                        </div>
                      </>
                    ) : (
                      <p>Select a geofence to see progress.</p>
                    )}
                  </div>
                </>
              ) : (
                <p>Draw or click a geofence to edit assignment and view progress.</p>
              )}
              {geofenceMessage && <p className="access-message">{geofenceMessage}</p>}
              {showGeofenceDeleteDialog && selectedGeofence && (
                <div
                  className="geofence-confirm-backdrop"
                  role="presentation"
                  onClick={(event) => {
                    if (event.target === event.currentTarget && !isGeofenceDeleting) {
                      setGeofenceDeleteConfirmId(null)
                    }
                  }}
                >
                  <div
                    className="geofence-confirm-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="geofence-delete-dialog-title"
                  >
                    <h4 id="geofence-delete-dialog-title">Delete this geofence?</h4>
                    <p>
                      <span className="geofence-confirm-name">{geofenceDisplayNameForDelete}</span> will be removed.
                      This cannot be undone.
                    </p>
                    <div className="geofence-confirm-actions">
                      <button
                        type="button"
                        className="geofence-confirm-cancel"
                        disabled={isGeofenceDeleting}
                        onClick={() => setGeofenceDeleteConfirmId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="geofence-confirm-delete"
                        disabled={isGeofenceDeleting}
                        onClick={() => void confirmGeofenceDelete()}
                      >
                        {isGeofenceDeleting ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </aside>
          )}
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
