import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet-draw'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
import { missingSupabaseConfig, supabase } from './lib/supabase'
import type {
  AddressRow,
  AdminGeofenceProgressRow,
  AdminMarkGeofenceResultRow,
  GeofenceProgress,
  GeofenceRow,
  ViewportBounds,
} from './features/app/types'
import {
  ADDRESS_CLUSTER_CROSS_GAP_METERS,
  ADDRESS_CLUSTER_MERGE_METERS,
  ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM,
  APP_ROLES,
  DOTS_VISIBLE_MIN_ZOOM_ADMIN,
  DOTS_VISIBLE_MIN_ZOOM_CANVASSER,
  RURAL_HALL_CENTER,
  accessDisplayName,
  addressHitIsGenerous,
  addressInAssignedGeofences,
  adminAddressHitRadiusPx,
  buildStreetGroups,
  canvasserAddressHitRadiusPx,
  clusterAddressesByProximity,
  clusterAddressesByViewportGrid,
  fetchAddressStatsInsidePolygon,
  mergeClustersByCrossGap,
  sortClustersSinglesFirst,
} from './features/app/utils'
import { useAuthFlow } from './features/auth/useAuthFlow'
import { useAccessPanel } from './features/access/useAccessPanel'
import { useViewportAddresses } from './features/addresses/useViewportAddresses'
import { useVisibleGeofences } from './features/geofences/useVisibleGeofences'
import {
  GeofenceDrawManager,
  GeofenceMarkCanvassedIcon,
  GeofenceTrashIcon,
  MapHelpInfoIcon,
  MapPaneSetup,
  MapStatusLine,
  MapViewportWatcher,
  PasswordEyeIcon,
} from './features/map/MapWorkspace'
import { CollapsibleStreetBlock, NearbyAddressSheet } from './features/canvasser/CanvasserWorkspace'
import './App.css'

/** New icon per marker: Leaflet must not reuse one DivIcon instance across multiple markers. */
function createClusterCountIcon(
  count: number,
  allCanvassed: boolean,
  compactHit: boolean,
): L.DivIcon {
  const badgeClass = allCanvassed
    ? 'address-cluster-hit__badge address-cluster-hit__badge--all-canvassed'
    : 'address-cluster-hit__badge'
  const hitClass = compactHit
    ? 'address-cluster-hit address-cluster-hit--compact'
    : 'address-cluster-hit'
  const size = compactHit ? 30 : 44
  const half = size / 2
  return L.divIcon({
    className: 'address-cluster-leaflet-marker',
    html: `<div class="${hitClass}" aria-hidden="true"><span class="${badgeClass}">${count}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [half, half],
  })
}


function App() {
  const [role, setRole] = useState<string>('')
  const [addresses, setAddresses] = useState<AddressRow[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [viewport, setViewport] = useState<ViewportBounds | null>(null)
  const [hitViewportLimit, setHitViewportLimit] = useState(false)
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
  const [markAllCompleteDialogOpen, setMarkAllCompleteDialogOpen] = useState(false)
  const [isMarkingAllComplete, setIsMarkingAllComplete] = useState(false)
  const [markAllTargetCanvassed, setMarkAllTargetCanvassed] = useState(true)
  const [geofencePanelMenuOpen, setGeofencePanelMenuOpen] = useState(false)
  const geofencePanelMenuRef = useRef<HTMLDivElement>(null)
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
  const geofenceAssigneePickerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const [mapReadySequence, setMapReadySequence] = useState(0)
  const [dotsEnabled, setDotsEnabled] = useState(false)
  const [addressPopupOpenId, setAddressPopupOpenId] = useState<string | null>(null)
  const [nearbyAddressSheet, setNearbyAddressSheet] = useState<{ memberIds: string[] } | null>(null)
  const [canvasserUiView, setCanvasserUiView] = useState<'map' | 'list'>('map')
  const [canvasserListAddresses, setCanvasserListAddresses] = useState<AddressRow[] | null>(null)
  const [isCanvasserListLoading, setIsCanvasserListLoading] = useState(false)
  const [canvasserListFetchError, setCanvasserListFetchError] = useState('')
  const [adminGeofencePanelExpanded, setAdminGeofencePanelExpanded] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.matchMedia('(min-width: 901px)').matches
  })
  const [canvasserMapHelpOpen, setCanvasserMapHelpOpen] = useState(false)
  const canvasserMapHelpRef = useRef<HTMLDivElement>(null)
  const accessActionsMenuRef = useRef<HTMLDivElement>(null)
  const handleAuthErrorMessage = useCallback((message: string) => {
    setErrorMessage(message)
  }, [])
  const handleSessionChanged = useCallback((nextSession: unknown) => {
    setRole('')
    setAddresses([])
    setErrorMessage('')
    void nextSession
  }, [])
  const {
    session,
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
    authMessage,
    setAuthMessage,
    isAuthSubmitting,
    isAuthLoading,
    continueWithEmail,
    signInWithPassword,
    sendPasswordResetEmail,
    completePasswordRecovery,
    signOut,
  } = useAuthFlow({
    onSetErrorMessage: handleAuthErrorMessage,
    onSessionChanged: handleSessionChanged,
  })
  const {
    accessRows,
    isProfilesLoading,
    isAddingUser,
    addUserModalOpen,
    setAddUserModalOpen,
    openAccessActionsEmail,
    setOpenAccessActionsEmail,
    accessMessage,
    setAccessMessage,
    newProfileName,
    setNewProfileName,
    newProfileEmail,
    setNewProfileEmail,
    newProfileRole,
    setNewProfileRole,
    editingUserEmail,
    editingUserNameDraft,
    setEditingUserNameDraft,
    editingUserEmailDraft,
    setEditingUserEmailDraft,
    editingUserRoleDraft,
    setEditingUserRoleDraft,
    upsertProfile,
    startEditUser,
    cancelEditUser,
    saveEditedUser,
    deleteUserAccess,
  } = useAccessPanel({ role, session })
  const setAddressesFromViewport = useCallback((rows: AddressRow[]) => {
    setAddresses(rows)
  }, [])
  const setHitViewportLimitFromViewport = useCallback((next: boolean) => {
    setHitViewportLimit(next)
  }, [])
  const setErrorMessageFromViewport = useCallback((message: string) => {
    setErrorMessage(message)
  }, [])
  useViewportAddresses({
    sessionUserId: session?.user?.id,
    role,
    viewport,
    onSetAddresses: setAddressesFromViewport,
    onSetHitViewportLimit: setHitViewportLimitFromViewport,
    onSetErrorMessage: setErrorMessageFromViewport,
  })
  const setGeofencesFromHook = useCallback((rows: GeofenceRow[]) => {
    setGeofences(rows)
  }, [])
  const setGeofenceMessageFromHook = useCallback((message: string) => {
    setGeofenceMessage(message)
  }, [])
  useVisibleGeofences({
    sessionUserId: session?.user?.id,
    role,
    onSetGeofences: setGeofencesFromHook,
    onSetGeofenceMessage: setGeofenceMessageFromHook,
  })
  const selectedGeofence = useMemo(
    () => geofences.find((fence) => fence.id === selectedGeofenceId) ?? null,
    [geofences, selectedGeofenceId],
  )
  const sessionEmail = (session?.user?.email ?? '').trim().toLowerCase()
  const assignedGeofenceIdList = useMemo(
    () =>
      geofences
        .filter((g) => (g.assigned_email ?? '').trim().toLowerCase() === sessionEmail)
        .map((g) => g.id),
    [geofences, sessionEmail],
  )
  const assignedGeofenceIdSet = useMemo(
    () => new Set(assignedGeofenceIdList),
    [assignedGeofenceIdList],
  )
  const assignedGeofenceNames = useMemo(
    () =>
      geofences
        .filter((g) => assignedGeofenceIdSet.has(g.id))
        .map((g) => g.name.trim())
        .filter((name) => name.length > 0),
    [geofences, assignedGeofenceIdSet],
  )
  const canvasserAreasTitle = useMemo(() => {
    if (assignedGeofenceNames.length === 0) return 'Assigned areas'
    if (assignedGeofenceNames.length === 1) return assignedGeofenceNames[0]!
    return `${assignedGeofenceNames[0]} +${assignedGeofenceNames.length - 1}`
  }, [assignedGeofenceNames])
  const geofencesForMap = useMemo(() => {
    if (role !== 'canvasser') return geofences
    return geofences.filter((g) => assignedGeofenceIdSet.has(g.id))
  }, [role, geofences, assignedGeofenceIdSet])
  const geofenceDisplayNameForDelete = useMemo(() => {
    if (!selectedGeofence) return ''
    const trimmed = geofenceNameDraft.trim()
    return trimmed || selectedGeofence.name || 'Unnamed geofence'
  }, [geofenceNameDraft, selectedGeofence])
  const geofenceDetailsTitle = useMemo(() => {
    if (!selectedGeofence) return 'Geofence details'
    const draft = geofenceNameDraft.trim()
    const persisted = selectedGeofence.name?.trim() ?? ''
    const title = draft || persisted
    return title ? `${title} details` : 'Geofence details'
  }, [selectedGeofence, geofenceNameDraft])
  const geofenceCompletionPercent = useMemo(() => {
    if (!geofenceProgress || geofenceProgress.total === 0) return 0
    return Math.round((geofenceProgress.canvassed / geofenceProgress.total) * 100)
  }, [geofenceProgress])
  const canSubmitPasswordStep =
    authPasswordIntent === 'sign_in'
      ? authPassword.length > 0
      : authPassword.length >= 8 &&
        authPasswordConfirm.length > 0 &&
        authPassword === authPasswordConfirm
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
  /** Canvassers: only dots inside assigned geofences. Admins: all in view, or only inside selected geofence when dots are on. */
  const addressesForMapDots = useMemo(() => {
    if (role !== 'canvasser') {
      if (
        role === 'admin' &&
        dotsEnabled &&
        selectedGeofence?.geometry &&
        selectedGeofenceId
      ) {
        return validAddresses.filter((address) =>
          booleanPointInPolygon(point([address.long, address.lat]), selectedGeofence.geometry),
        )
      }
      return validAddresses
    }
    if (assignedGeofenceIdList.length === 0) {
      return []
    }
    return validAddresses.filter((address) =>
      addressInAssignedGeofences(address, geofences, assignedGeofenceIdSet),
    )
  }, [
    role,
    dotsEnabled,
    validAddresses,
    selectedGeofence,
    selectedGeofenceId,
    assignedGeofenceIdList,
    geofences,
    assignedGeofenceIdSet,
  ])
  const addressClustersForMap = useMemo(() => {
    if (addressesForMapDots.length === 0) return []

    const useProximityClustering =
      role !== 'admin' ||
      !viewport ||
      viewport.zoom >= ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM

    if (!useProximityClustering) {
      const cellPixels = viewport.zoom <= 14 ? 72 : viewport.zoom <= 15 ? 56 : 48
      const raw = clusterAddressesByViewportGrid(addressesForMapDots, viewport, cellPixels)
      return sortClustersSinglesFirst(raw)
    }

    const linked = clusterAddressesByProximity(addressesForMapDots, ADDRESS_CLUSTER_MERGE_METERS)
    const merged = mergeClustersByCrossGap(linked, ADDRESS_CLUSTER_CROSS_GAP_METERS)
    return sortClustersSinglesFirst(merged)
  }, [addressesForMapDots, role, viewport])
  const canvasserListRowsLive = useMemo(() => {
    if (!canvasserListAddresses) return []
    const byId = new Map<string, AddressRow>()
    for (const row of canvasserListAddresses) {
      const merged = addresses.find((a) => a.id === row.id) ?? row
      byId.set(row.id, merged)
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.full_address.localeCompare(b.full_address, undefined, { numeric: true }),
    )
  }, [canvasserListAddresses, addresses])
  const canvasserListProgress = useMemo(() => {
    const rows = canvasserListRowsLive
    if (rows.length === 0) return null
    const done = rows.filter((r) => r.canvassed).length
    const total = rows.length
    return { done, total, percent: Math.round((done / total) * 100) }
  }, [canvasserListRowsLive])
  const canvasserStreetGroups = useMemo(
    () => buildStreetGroups(canvasserListRowsLive),
    [canvasserListRowsLive],
  )
  const adminCount = useMemo(
    () => accessRows.filter((entry) => entry.role === 'admin').length,
    [accessRows],
  )
  const geofenceAssigneeOptions = useMemo(() => {
    const options = accessRows.map((entry) => {
      const normalized = entry.email.trim().toLowerCase()
      return {
        value: normalized,
        label: accessDisplayName(entry),
      }
    })
    if (
      geofenceEmailDraft &&
      !options.some((option) => option.value === geofenceEmailDraft.trim().toLowerCase())
    ) {
      options.push({
        value: geofenceEmailDraft.trim().toLowerCase(),
        label: `${geofenceEmailDraft.trim()} (not in Admin Access list)`,
      })
    }
    return options.sort((a, b) => a.label.localeCompare(b.label))
  }, [accessRows, geofenceEmailDraft])
  const selectedAssigneeOption = useMemo(
    () =>
      geofenceAssigneeOptions.find(
        (option) => option.value === geofenceEmailDraft.trim().toLowerCase(),
      ) ?? null,
    [geofenceAssigneeOptions, geofenceEmailDraft],
  )
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- role-driven UI default */
    if (role === 'admin') {
      setDotsEnabled(false)
    } else if (role === 'canvasser') {
      setDotsEnabled(true)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [role])

  useEffect(() => {
    const fetchProfileRole = async () => {
      if (!supabase || !session?.user || isPasswordRecovery) {
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

      if (!resolvedRole && normalizedEmail) {
        const { data: accessByEmail, error: accessByEmailError } = await supabase
          .from('user_access')
          .select('role')
          .eq('email', normalizedEmail)
          .maybeSingle()

        if (accessByEmailError) {
          setErrorMessage(accessByEmailError.message)
          return
        }

        resolvedRole = accessByEmail?.role ?? ''
      }

      const nextRole = resolvedRole
      if (!APP_ROLES.has(nextRole)) {
        setErrorMessage(
          `Account is authenticated but not assigned a valid app role yet. Logged in as ${
            normalizedEmail ?? 'unknown email'
          }.`,
        )
        setRole('')
        return
      }
      setRole(nextRole)
    }

    void fetchProfileRole()
  }, [session, isPasswordRecovery])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)')
    const onChange = () => {
      if (mq.matches) {
        setAdminGeofencePanelExpanded(false)
      } else {
        setAdminGeofencePanelExpanded(true)
      }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!canvasserMapHelpOpen) {
      return
    }
    const onDocMouseDown = (event: MouseEvent) => {
      const el = canvasserMapHelpRef.current
      if (el && !el.contains(event.target as Node)) {
        setCanvasserMapHelpOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCanvasserMapHelpOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [canvasserMapHelpOpen])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- full assigned-area address list for list + map metrics */
    if (role !== 'canvasser' || !supabase) {
      setCanvasserListAddresses(null)
      setCanvasserListFetchError('')
      setIsCanvasserListLoading(false)
      return
    }
    if (assignedGeofenceIdList.length === 0) {
      setCanvasserListAddresses([])
      setCanvasserListFetchError('')
      setIsCanvasserListLoading(false)
      return
    }

    const fences = geofences.filter((g) => assignedGeofenceIdList.includes(g.id))
    if (fences.length === 0) {
      setCanvasserListAddresses([])
      setIsCanvasserListLoading(false)
      return
    }

    let minLat = Infinity
    let maxLat = -Infinity
    let minLng = Infinity
    let maxLng = -Infinity
    for (const f of fences) {
      const ring = f.geometry.coordinates[0] ?? []
      for (const [lng, lat] of ring) {
        minLat = Math.min(minLat, lat)
        maxLat = Math.max(maxLat, lat)
        minLng = Math.min(minLng, lng)
        maxLng = Math.max(maxLng, lng)
      }
    }

    let cancelled = false
    setIsCanvasserListLoading(true)
    setCanvasserListFetchError('')

    const run = async () => {
      const byId = new Map<string, AddressRow>()
      let from = 0
      const pageSize = 1000
      let done = false
      while (!done && !cancelled) {
        const { data, error } = await supabase
          .from('addresses')
          .select('id,full_address,lat,long,canvassed')
          .gte('lat', minLat)
          .lte('lat', maxLat)
          .gte('long', minLng)
          .lte('long', maxLng)
          .range(from, from + pageSize - 1)
        if (error) {
          if (!cancelled) {
            setCanvasserListFetchError(error.message)
            setCanvasserListAddresses([])
            setIsCanvasserListLoading(false)
          }
          break
        }
        const rows = (data as AddressRow[]) ?? []
        for (const row of rows) {
          if (
            !byId.has(row.id) &&
            fences.some((f) => booleanPointInPolygon(point([row.long, row.lat]), f.geometry))
          ) {
            byId.set(row.id, row)
          }
        }
        if (rows.length < pageSize) done = true
        else from += pageSize
      }
      if (!cancelled) {
        const list = Array.from(byId.values()).sort((a, b) =>
          a.full_address.localeCompare(b.full_address),
        )
        setCanvasserListAddresses(list)
        setIsCanvasserListLoading(false)
      }
    }

    void run()
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      cancelled = true
    }
  }, [role, assignedGeofenceIdList, geofences])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- selected geofence controls local draft state */
    if (!selectedGeofence) {
      setGeofenceProgress(null)
      return
    }
    setGeofenceNameDraft(selectedGeofence.name)
    setGeofenceEmailDraft(selectedGeofence.assigned_email ?? '')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedGeofenceId, selectedGeofence])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- geofence progress lifecycle controls */
    if (!selectedGeofenceId || !supabase) {
      setGeofenceProgress(null)
      setIsGeofenceProgressLoading(false)
      return
    }
    const fence = geofences.find((f) => f.id === selectedGeofenceId) ?? null
    if (!fence) {
      setGeofenceProgress(null)
      setIsGeofenceProgressLoading(false)
      return
    }
    let cancelled = false
    const run = async () => {
      setIsGeofenceProgressLoading(true)
      try {
        const { data, error } = await supabase.rpc('admin_get_geofence_progress', {
          p_geofence_id: selectedGeofenceId,
        })
        let p: GeofenceProgress
        if (error) {
          // Fallback keeps admin progress working before/if the RPC is deployed.
          p = await fetchAddressStatsInsidePolygon(supabase, fence.geometry)
        } else {
          const row = ((data as AdminGeofenceProgressRow[] | null) ?? [])[0]
          p = {
            total: row?.total_count ?? 0,
            canvassed: row?.canvassed_count ?? 0,
            remaining: row?.remaining_count ?? 0,
          }
        }
        if (!cancelled) {
          setGeofenceProgress(p)
        }
      } catch (e) {
        if (!cancelled) {
          setGeofenceProgress(null)
          setGeofenceMessage(e instanceof Error ? e.message : 'Failed to load progress')
        }
      } finally {
        if (!cancelled) {
          setIsGeofenceProgressLoading(false)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedGeofenceId, geofences])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reset panel/dialog state when fence changes */
    setMarkAllCompleteDialogOpen(false)
    setGeofencePanelMenuOpen(false)
    setAssigneePickerOpen(false)
    setGeofenceMessage('')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedGeofenceId])

  useEffect(() => {
    if (!assigneePickerOpen) return
    const onDocMouseDown = (event: MouseEvent) => {
      const el = geofenceAssigneePickerRef.current
      if (el && !el.contains(event.target as Node)) {
        setAssigneePickerOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAssigneePickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [assigneePickerOpen])

  useEffect(() => {
    if (!geofencePanelMenuOpen) return
    const onDocMouseDown = (event: MouseEvent) => {
      const el = geofencePanelMenuRef.current
      if (el && !el.contains(event.target as Node)) {
        setGeofencePanelMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGeofencePanelMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [geofencePanelMenuOpen])

  useEffect(() => {
    if (!markAllCompleteDialogOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isMarkingAllComplete) {
        event.preventDefault()
        setMarkAllCompleteDialogOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [markAllCompleteDialogOpen, isMarkingAllComplete])

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

  useEffect(() => {
    if (!nearbyAddressSheet) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setNearbyAddressSheet(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [nearbyAddressSheet])

  useEffect(() => {
    if (!addUserModalOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isAddingUser) {
        event.preventDefault()
        setAddUserModalOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addUserModalOpen, isAddingUser, setAddUserModalOpen])

  useEffect(() => {
    if (!openAccessActionsEmail) return
    const onDocMouseDown = (event: MouseEvent) => {
      const el = accessActionsMenuRef.current
      if (el && !el.contains(event.target as Node)) {
        setOpenAccessActionsEmail('')
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenAccessActionsEmail('')
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openAccessActionsEmail, setOpenAccessActionsEmail])

  useEffect(() => {
    if (!mapRef.current) return
    // Leaflet can leave gray tile artifacts after overlay/panel layout changes on mobile.
    const raf = window.requestAnimationFrame(() => {
      mapRef.current?.invalidateSize(false)
    })
    const timer = window.setTimeout(() => {
      mapRef.current?.invalidateSize(false)
    }, 140)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [adminGeofencePanelExpanded, geofencePanelMenuOpen])

  useEffect(() => {
    if (role !== 'canvasser' || canvasserUiView !== 'map') {
      return
    }
    if (assignedGeofenceIdList.length === 0) {
      return
    }
    const map = mapRef.current
    if (!map) {
      return
    }

    const assignedFences = geofences.filter((g) => assignedGeofenceIdSet.has(g.id))
    if (assignedFences.length === 0) {
      return
    }

    const bounds = L.latLngBounds([])
    assignedFences.forEach((fence) => {
      const ring = fence.geometry.coordinates[0] ?? []
      ring.forEach(([lng, lat]) => {
        bounds.extend([lat, lng])
      })
    })
    if (!bounds.isValid()) {
      return
    }

    // Wait one frame after map/tab mount so Leaflet has final dimensions before fitting.
    const raf = window.requestAnimationFrame(() => {
      map.fitBounds(bounds, {
        padding: [34, 34],
        maxZoom: 16,
      })
    })
    return () => window.cancelAnimationFrame(raf)
  }, [
    role,
    canvasserUiView,
    sessionEmail,
    assignedGeofenceIdList,
    assignedGeofenceIdSet,
    geofences,
    mapReadySequence,
  ])

  const centerPoint = useMemo<[number, number]>(() => RURAL_HALL_CENTER, [])
  const isCloseZoom = (viewport?.zoom ?? 13) >= ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM
  const dotsVisibleMinZoom = role === 'admin' ? DOTS_VISIBLE_MIN_ZOOM_ADMIN : DOTS_VISIBLE_MIN_ZOOM_CANVASSER
  const showAddressDots = dotsEnabled && (viewport?.zoom ?? 13) >= dotsVisibleMinZoom

  const toggleCanvassed = async (
    address: AddressRow,
    options?: { closePopupOnToggle?: boolean },
  ) => {
    if (!supabase) {
      setErrorMessage(missingSupabaseConfig)
      return
    }

    if (role !== 'admin' && role !== 'canvasser') {
      setErrorMessage('You do not have permission to update addresses.')
      return
    }

    const nextState = !address.canvassed
    if (options?.closePopupOnToggle) {
      mapRef.current?.closePopup()
      setAddressPopupOpenId(null)
    }

    if (role === 'canvasser') {
      const inMine = addressInAssignedGeofences(address, geofences, assignedGeofenceIdSet)
      if (!inMine) {
        setErrorMessage('This address is outside your assigned areas.')
        return
      }
    }

    const addressIsInsideSelectedGeofence =
      role === 'admin' &&
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

    const { error } =
      role === 'admin'
        ? await supabase.rpc('admin_set_address_canvassed', {
            p_address_id: address.id,
            p_canvassed: nextState,
          })
        : await supabase.rpc('canvasser_set_address_canvassed', {
            p_address_id: address.id,
            p_canvassed: nextState,
          })

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

  const confirmMarkAllAddressesInGeofence = async () => {
    if (!supabase || !selectedGeofence || role !== 'admin') return
    setIsMarkingAllComplete(true)
    setGeofenceMessage('')
    try {
      const { data, error } = await supabase.rpc('admin_mark_geofence_addresses_canvassed', {
        p_geofence_id: selectedGeofence.id,
        p_canvassed: markAllTargetCanvassed,
      })
      if (error) {
        setGeofenceMessage(error.message)
        try {
          const p = await fetchAddressStatsInsidePolygon(supabase, selectedGeofence.geometry)
          setGeofenceProgress(p)
        } catch {
          /* ignore */
        }
        setMarkAllCompleteDialogOpen(false)
        return
      }
      const row = ((data as AdminMarkGeofenceResultRow[] | null) ?? [])[0]
      const updatedCount = row?.updated_count ?? 0
      if (updatedCount === 0) {
        setGeofenceMessage(
          markAllTargetCanvassed
            ? 'Every address in this area is already canvassed.'
            : 'Every address in this area is already uncanvassed.',
        )
        setMarkAllCompleteDialogOpen(false)
        return
      }
      setAddresses((current) =>
        current.map((item) =>
          booleanPointInPolygon(point([item.long, item.lat]), selectedGeofence.geometry)
            ? { ...item, canvassed: markAllTargetCanvassed }
            : item,
        ),
      )
      setGeofenceProgress((prev) =>
        prev
          ? markAllTargetCanvassed
            ? { ...prev, canvassed: prev.total, remaining: 0 }
            : { ...prev, canvassed: 0, remaining: prev.total }
          : prev,
      )
      setGeofenceMessage(
        `Marked ${updatedCount} address${updatedCount === 1 ? '' : 'es'} as ${
          markAllTargetCanvassed ? 'canvassed' : 'uncanvassed'
        }.`,
      )
      setMarkAllCompleteDialogOpen(false)
    } catch (e) {
      setGeofenceMessage(e instanceof Error ? e.message : 'Could not update addresses.')
      if (selectedGeofence) {
        try {
          const p = await fetchAddressStatsInsidePolygon(supabase, selectedGeofence.geometry)
          setGeofenceProgress(p)
        } catch {
          /* ignore */
        }
      }
    } finally {
      setIsMarkingAllComplete(false)
    }
  }

  const handleGeofenceCreated = async (geometry: GeoJSON.Polygon) => {
    if (!supabase || role !== 'admin') return
    const { data, error } = await supabase.rpc('admin_insert_geofence', {
      p_name: 'New geofence',
      p_geometry: geometry,
      p_assigned_email: null,
    })
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
      const { error } = await supabase.rpc('admin_update_geofence_geometry', {
        p_geofence_id: update.id,
        p_geometry: update.geometry,
      })
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
    const { error } = await supabase.rpc('admin_delete_geofences', { p_ids: ids })
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
    const { error } = await supabase.rpc('admin_update_geofence_details', {
      p_geofence_id: selectedGeofenceId,
      p_name: name,
      p_assigned_email: assignedEmail ?? '',
    })
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
    if (role === 'admin') {
      setAdminGeofencePanelExpanded(true)
    }
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

  if (isPasswordRecovery) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Canvass</h1>
          <p>Set your new password.</p>
          <form className="auth-form" onSubmit={(event) => void completePasswordRecovery(event)}>
            <label htmlFor="recovery-password">New password</label>
            <div className="auth-password-input-wrap">
              <input
                id="recovery-password"
                type={resetPasswordVisible ? 'text' : 'password'}
                autoComplete="new-password"
                value={resetPasswordDraft}
                onChange={(event) => setResetPasswordDraft(event.target.value)}
                placeholder="At least 8 characters"
              />
              <button
                type="button"
                className="auth-password-toggle"
                aria-label={resetPasswordVisible ? 'Hide password' : 'Show password'}
                onClick={() => setResetPasswordVisible((current) => !current)}
              >
                <PasswordEyeIcon visible={resetPasswordVisible} />
              </button>
            </div>
            <label htmlFor="recovery-confirm-password">Confirm new password</label>
            <div className="auth-password-input-wrap">
              <input
                id="recovery-confirm-password"
                type={resetPasswordConfirmVisible ? 'text' : 'password'}
                autoComplete="new-password"
                value={resetPasswordConfirmDraft}
                onChange={(event) => setResetPasswordConfirmDraft(event.target.value)}
                placeholder="Re-enter new password"
              />
              <button
                type="button"
                className="auth-password-toggle"
                aria-label={resetPasswordConfirmVisible ? 'Hide password' : 'Show password'}
                onClick={() => setResetPasswordConfirmVisible((current) => !current)}
              >
                <PasswordEyeIcon visible={resetPasswordConfirmVisible} />
              </button>
            </div>
            <button type="submit" className="auth-primary-button" disabled={isAuthSubmitting}>
              {isAuthSubmitting ? 'Saving...' : 'Save new password'}
            </button>
          </form>
          {authMessage && <p className="auth-message">{authMessage}</p>}
          {errorMessage && <p className="error-banner">{errorMessage}</p>}
        </section>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Canvass</h1>
          <p>
            {authStep === 'email'
              ? 'Enter your assigned email to continue.'
              : authStep === 'email-instructions'
                ? 'If an account exists for this email, check your inbox for the next step.'
                : authPasswordIntent === 'sign_in'
                  ? `Welcome back. Enter your password for ${authEmail.trim().toLowerCase()}.`
                  : `Create a password for ${authEmail.trim().toLowerCase()}. Use at least 8 characters.`}
          </p>
          {authStep === 'email' ? (
            <form className="auth-form" onSubmit={(event) => void continueWithEmail(event)}>
              <div className="auth-field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={authEmail}
                  onChange={(event) => setAuthEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <button type="submit" className="auth-primary-button" disabled={isAuthSubmitting}>
                Continue
              </button>
            </form>
          ) : authStep === 'email-instructions' ? (
            <form className="auth-form" onSubmit={(event) => event.preventDefault()}>
              <div className="auth-actions">
                <button
                  type="button"
                  className="auth-primary-button"
                  disabled={isAuthSubmitting}
                  onClick={() => {
                    setAuthPassword('')
                    setAuthPasswordConfirm('')
                    setAuthPasswordVisible(false)
                    setAuthPasswordConfirmVisible(false)
                    setAuthMessage('')
                    setAuthPasswordIntent('create_password')
                    setAuthStep('email')
                  }}
                >
                  Use a different email
                </button>
              </div>
            </form>
          ) : (
            <form className="auth-form" onSubmit={(event) => void signInWithPassword(event)}>
              <div className="auth-field">
                <label htmlFor="password">
                  {authPasswordIntent === 'sign_in' ? 'Password' : 'New password'}
                </label>
                <div className="auth-password-input-wrap">
                  <input
                    id="password"
                    type={authPasswordVisible ? 'text' : 'password'}
                    autoComplete={
                      authPasswordIntent === 'sign_in' ? 'current-password' : 'new-password'
                    }
                    value={authPassword}
                    onChange={(event) => setAuthPassword(event.target.value)}
                    placeholder={
                      authPasswordIntent === 'sign_in' ? undefined : 'At least 8 characters'
                    }
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    aria-label={authPasswordVisible ? 'Hide password' : 'Show password'}
                    onClick={() => setAuthPasswordVisible((current) => !current)}
                  >
                    <PasswordEyeIcon visible={authPasswordVisible} />
                  </button>
                </div>
              </div>
              {authPasswordIntent === 'create_password' ? (
                <div className="auth-field">
                  <label htmlFor="password-confirm">Confirm password</label>
                  <div className="auth-password-input-wrap">
                    <input
                      id="password-confirm"
                      type={authPasswordConfirmVisible ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={authPasswordConfirm}
                      onChange={(event) => setAuthPasswordConfirm(event.target.value)}
                      placeholder="Re-enter password"
                    />
                    <button
                      type="button"
                      className="auth-password-toggle"
                      aria-label={authPasswordConfirmVisible ? 'Hide password' : 'Show password'}
                      onClick={() => setAuthPasswordConfirmVisible((current) => !current)}
                    >
                      <PasswordEyeIcon visible={authPasswordConfirmVisible} />
                    </button>
                  </div>
                </div>
              ) : null}
              {authPasswordIntent === 'sign_in' ? (
                <button
                  type="button"
                  className="auth-inline-link"
                  disabled={isAuthSubmitting}
                  onClick={() => void sendPasswordResetEmail()}
                >
                  Forgot password?
                </button>
              ) : null}
              <div className="auth-actions">
                <button
                  type="submit"
                  className="auth-primary-button"
                  disabled={isAuthSubmitting || !canSubmitPasswordStep}
                >
                  {isAuthSubmitting
                    ? 'Submitting...'
                    : authPasswordIntent === 'sign_in'
                      ? 'Sign in'
                      : 'Create account'}
                </button>
                <button
                  type="button"
                  className="auth-secondary-button"
                  disabled={isAuthSubmitting}
                  onClick={() => {
                    setAuthPassword('')
                    setAuthPasswordConfirm('')
                    setAuthPasswordVisible(false)
                    setAuthPasswordConfirmVisible(false)
                    setAuthMessage('')
                    setAuthPasswordIntent('create_password')
                    setAuthStep('email')
                  }}
                >
                  Use a different email
                </button>
              </div>
            </form>
          )}
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
        <span className="top-bar-user-email">{session.user.email ?? ''}</span>
        <button type="button" className="signout-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      {role === 'admin' && (
        <div className="map-toolbar-row">
          <nav className="map-toolbar-nav" aria-label="Admin pages">
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
          {activeAdminView === 'map' && (
            <MapStatusLine
              dotsEnabled={dotsEnabled}
              showAddressDots={showAddressDots}
              hitViewportLimit={hitViewportLimit}
              role={role}
            />
          )}
        </div>
      )}

      {role === 'canvasser' && canvasserUiView === 'list' && (
        <nav className="canvasser-view-nav" aria-label="Canvasser views">
          <button type="button" className="view-tab" onClick={() => setCanvasserUiView('map')}>
            Map
          </button>
          <button type="button" className="view-tab active" onClick={() => setCanvasserUiView('list')}>
            Address list
          </button>
        </nav>
      )}

      {role === 'canvasser' && canvasserUiView === 'map' && (
        <div className="map-toolbar-row">
          <nav className="map-toolbar-nav" aria-label="Canvasser views">
            <button type="button" className="view-tab active" onClick={() => setCanvasserUiView('map')}>
              Map
            </button>
            <button type="button" className="view-tab" onClick={() => setCanvasserUiView('list')}>
              Address list
            </button>
          </nav>
          <MapStatusLine
            dotsEnabled={dotsEnabled}
            showAddressDots={showAddressDots}
            hitViewportLimit={hitViewportLimit}
            role={role}
          />
        </div>
      )}

      {errorMessage && <p className="error-banner">{errorMessage}</p>}

      {role === 'canvasser' && canvasserUiView === 'list' ? (
        <section className="canvasser-list-page" aria-label="Addresses in your assigned areas">
          <div className="canvasser-list-toolbar">
            <h2 className="canvasser-list-title">Your addresses</h2>
            {canvasserListProgress ? (
              <span className="canvasser-list-progress">
                {canvasserListProgress.done}/{canvasserListProgress.total} ·{' '}
                {canvasserListProgress.percent}%
              </span>
            ) : null}
          </div>
          {canvasserListProgress ? (
            <div
              className="canvasser-list-progress-wrap"
              role="group"
              aria-label="Progress in your assigned geofences"
            >
              <div
                className="canvasser-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={canvasserListProgress.percent}
                aria-valuetext={`${canvasserListProgress.done} of ${canvasserListProgress.total} addresses canvassed`}
              >
                <div
                  className="canvasser-progress-fill"
                  style={{ width: `${canvasserListProgress.percent}%` }}
                />
              </div>
              <p className="canvasser-list-metrics-line">
                {canvasserListProgress.total} in your assigned areas · {canvasserListProgress.done}{' '}
                canvassed
              </p>
            </div>
          ) : null}
          {assignedGeofenceIdList.length === 0 ? (
            <p className="canvasser-list-empty">No geofences are assigned to your email yet.</p>
          ) : isCanvasserListLoading ? (
            <p className="canvasser-list-empty">Loading addresses in your areas…</p>
          ) : canvasserListFetchError ? (
            <p className="error-banner">{canvasserListFetchError}</p>
          ) : canvasserListRowsLive.length === 0 ? (
            <p className="canvasser-list-empty">No addresses found inside your assigned geofences.</p>
          ) : (
            <div className="canvasser-list-body">
              {canvasserStreetGroups.map((group) => (
                <CollapsibleStreetBlock
                  key={group.sortKey}
                  blockClassName="canvasser-street-block"
                  defaultOpen={false}
                  summaryClassName="canvasser-street-summary"
                  nameClassName="canvasser-street-name"
                  metaClassName="canvasser-street-count"
                  heading={group.heading}
                  meta={`${group.rows.filter((r) => r.canvassed).length}/${group.rows.length} canvassed`}
                >
                  <ul className="canvasser-street-ul">
                    {group.rows.map((address) => {
                      const canToggle = addressInAssignedGeofences(
                        address,
                        geofences,
                        assignedGeofenceIdSet,
                      )
                      return (
                        <li key={address.id} className="canvasser-list-row">
                          <div className="canvasser-list-row-main">
                            <span className="canvasser-list-address">{address.full_address}</span>
                            <span
                              className={`nearby-sheet-pill ${address.canvassed ? 'done' : 'todo'}`}
                            >
                              {address.canvassed ? 'Canvassed' : 'Not canvassed'}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="nearby-sheet-action"
                            disabled={!canToggle}
                            onClick={() => void toggleCanvassed(address)}
                          >
                            {canToggle
                              ? address.canvassed
                                ? 'Mark uncanvassed'
                                : 'Mark canvassed'
                              : 'Outside your areas'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </CollapsibleStreetBlock>
              ))}
            </div>
          )}
        </section>
      ) : (role !== 'admin' || activeAdminView === 'map') ? (
        <section className="map-page">
          <section className="map-panel">
            <MapContainer
              center={centerPoint}
              zoom={13}
              scrollWheelZoom
              className="map-view"
              ref={mapRef}
              whenReady={() => setMapReadySequence((v) => v + 1)}
            >
              <MapPaneSetup />
              {role === 'canvasser' && (
                <div className="map-help-anchor" ref={canvasserMapHelpRef}>
                  <button
                    type="button"
                    className="map-help-icon-button"
                    aria-expanded={canvasserMapHelpOpen}
                    aria-haspopup="dialog"
                    aria-controls="canvasser-map-help-popover"
                    onClick={() => setCanvasserMapHelpOpen((open) => !open)}
                    aria-label="Map tips for assigned areas"
                  >
                    <MapHelpInfoIcon />
                  </button>
                  {canvasserMapHelpOpen ? (
                    <div
                      className="canvasser-map-help-popover"
                      id="canvasser-map-help-popover"
                      role="dialog"
                      aria-label="Map tips"
                    >
                      <div className="canvasser-map-help-popover-header">
                        <span>Map tips</span>
                        <button
                          type="button"
                          className="canvasser-map-help-close"
                          aria-label="Close map tips"
                          onClick={() => setCanvasserMapHelpOpen(false)}
                        >
                          ×
                        </button>
                      </div>
                      {assignedGeofenceIdList.length > 0 ? (
                        <ul className="canvasser-map-help-list">
                          <li>
                            <strong>Purple polygons</strong> show your assigned areas on the map.
                          </li>
                          <li>
                            A <strong>numbered red badge</strong> means several addresses share one
                            point. Tap it to open a scrollable list.
                          </li>
                          <li>
                            You can mark addresses <strong>canvassed</strong> by clicking address
                            dots, or by using the{' '}
                            <button
                              type="button"
                              className="canvasser-map-help-link"
                              aria-label="Open Address list tab"
                              onClick={() => {
                                setCanvasserUiView('list')
                                setCanvasserMapHelpOpen(false)
                              }}
                            >
                              Address list
                            </button>
                            .
                          </li>
                        </ul>
                      ) : (
                        <ul className="canvasser-map-help-list">
                          <li>No geofences are assigned to your email yet.</li>
                          <li>
                            Ask an admin to assign areas. You will see polygons and address dots for
                            your assigned areas after that.
                          </li>
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
              <MapViewportWatcher onViewportChange={setViewport} />
              <GeofenceDrawManager
                geofences={geofencesForMap}
                enabled={role === 'admin'}
                allowGeofenceSelect={role === 'admin'}
                assignedGeofenceIdList={assignedGeofenceIdList}
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
                addressClustersForMap.map((members) => {
                  const clusterKey = members
                    .map((m) => m.id)
                    .sort()
                    .join('|')
                  if (members.length === 1) {
                    const address = members[0]
                    const canToggleThisAddress =
                      role === 'admin' ||
                      (role === 'canvasser' &&
                        addressInAssignedGeofences(address, geofences, assignedGeofenceIdSet))
                    const isPopupOpen = addressPopupOpenId === address.id
                    const baseRadius = address.canvassed ? 8 : 7
                    const visualRadius = baseRadius + (isPopupOpen ? 4 : 0)
                    const visualWeight = (address.canvassed ? 3 : 2) + (isPopupOpen ? 1 : 0)
                    const popupOpenHandlers = {
                      popupopen: () => setAddressPopupOpenId(address.id),
                      popupclose: () =>
                        setAddressPopupOpenId((prev) => (prev === address.id ? null : prev)),
                    }
                    const popupContent = (
                      <>
                        <p className="popup-address">{address.full_address}</p>
                        <button
                          type="button"
                          className="status-button"
                          disabled={!canToggleThisAddress}
                          onClick={() =>
                            void toggleCanvassed(address, { closePopupOnToggle: true })
                          }
                        >
                          {role === 'admin'
                            ? address.canvassed
                              ? 'Mark uncanvassed'
                              : 'Mark canvassed'
                            : canToggleThisAddress
                              ? address.canvassed
                                ? 'Mark uncanvassed'
                                : 'Mark canvassed'
                              : 'Outside your assigned areas'}
                        </button>
                      </>
                    )
                    const visualPathOptions = {
                      color: address.canvassed ? '#ffffff' : '#7f1d1d',
                      fillColor: address.canvassed ? '#2563eb' : '#dc2626',
                      fillOpacity: 1,
                      weight: visualWeight,
                      className: isPopupOpen
                        ? 'address-dot-visual address-dot-visual--open'
                        : 'address-dot-visual',
                    }
                    return (
                      <Fragment key={address.id}>
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
                        {role === 'canvasser' ? (
                          <>
                            <CircleMarker
                              key={`${address.id}-visual`}
                              center={[address.lat, address.long]}
                              pane="addressPane"
                              radius={visualRadius}
                              interactive={false}
                              pathOptions={visualPathOptions}
                            />
                            <CircleMarker
                              key={`${address.id}-hit`}
                              center={[address.lat, address.long]}
                              pane="addressPane"
                              radius={canvasserAddressHitRadiusPx(viewport?.zoom ?? 13)}
                              pathOptions={{
                                className: 'address-marker-hit',
                                color: '#000000',
                                opacity: 0,
                                fillColor: '#000000',
                                fillOpacity: 0.001,
                                weight: 0,
                              }}
                              eventHandlers={popupOpenHandlers}
                            >
                              <Popup>{popupContent}</Popup>
                            </CircleMarker>
                          </>
                        ) : (
                          <>
                            <CircleMarker
                              key={`${address.id}-visual`}
                              center={[address.lat, address.long]}
                              pane="addressPane"
                              radius={visualRadius}
                              interactive={false}
                              pathOptions={visualPathOptions}
                            />
                            <CircleMarker
                              key={`${address.id}-hit`}
                              center={[address.lat, address.long]}
                              pane="addressPane"
                              radius={adminAddressHitRadiusPx(
                                viewport?.zoom ?? 13,
                                visualRadius,
                              )}
                              pathOptions={{
                                className: 'address-marker-hit address-marker-hit--admin',
                                color: '#000000',
                                opacity: 0,
                                fillColor: '#000000',
                                fillOpacity: 0.001,
                                weight: 0,
                              }}
                              eventHandlers={popupOpenHandlers}
                            >
                              <Popup>{popupContent}</Popup>
                            </CircleMarker>
                          </>
                        )}
                      </Fragment>
                    )
                  }
                  const centroidLat =
                    members.reduce((sum, m) => sum + m.lat, 0) / members.length
                  const centroidLng =
                    members.reduce((sum, m) => sum + m.long, 0) / members.length
                  const allCanvassed =
                    members.length > 0 && members.every((m) => m.canvassed)
                  const sortedMembers = [...members].sort((a, b) =>
                    a.full_address.localeCompare(b.full_address),
                  )
                  return (
                    <Fragment key={clusterKey}>
                      {allCanvassed && (
                        <CircleMarker
                          key={`${clusterKey}-halo`}
                          center={[centroidLat, centroidLng]}
                          pane="addressPane"
                          radius={isCloseZoom ? 22 : 15}
                          interactive={false}
                          pathOptions={{
                            color: '#1d4ed8',
                            fillColor: '#60a5fa',
                            fillOpacity: 0.22,
                            weight: 2,
                          }}
                        />
                      )}
                      <Marker
                        position={[centroidLat, centroidLng]}
                        pane="addressPane"
                        icon={createClusterCountIcon(
                          members.length,
                          allCanvassed,
                          !addressHitIsGenerous(viewport?.zoom ?? 13),
                        )}
                        eventHandlers={{
                          click: () => {
                            setNearbyAddressSheet({
                              memberIds: sortedMembers.map((m) => m.id),
                            })
                          },
                        }}
                      />
                    </Fragment>
                  )
                })}
            </MapContainer>
            <button
              type="button"
              className="map-icon-control"
              title={dotsEnabled ? 'Hide address dots' : 'Show address dots'}
              aria-label={dotsEnabled ? 'Hide address dots' : 'Show address dots'}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setDotsEnabled((current) => !current)}
            >
              {dotsEnabled ? '◉' : '○'}
            </button>
            {nearbyAddressSheet && (
              <NearbyAddressSheet
                memberIds={nearbyAddressSheet.memberIds}
                addresses={addresses}
                role={role}
                geofences={geofences}
                assignedGeofenceIdSet={assignedGeofenceIdSet}
                onClose={() => setNearbyAddressSheet(null)}
                onToggle={toggleCanvassed}
              />
            )}
          </section>
          {role === 'canvasser' && (
            <aside
              className="geofence-panel canvasser-areas-panel canvasser-areas-panel--expanded"
              aria-label="Your assigned areas"
            >
              <div className="canvasser-areas-expandable">
                <div className="geofence-panel-header canvasser-areas-panel-title-row">
                  <h3>{canvasserAreasTitle}</h3>
                </div>
                {assignedGeofenceIdList.length === 0 ? (
                  <p className="geofence-panel-lead">
                    No geofences are assigned to your email yet. Ask an admin to assign an area.
                  </p>
                ) : isCanvasserListLoading ? (
                  <p className="geofence-panel-lead">Loading addresses in your areas…</p>
                ) : canvasserListFetchError ? (
                  <p className="error-banner">{canvasserListFetchError}</p>
                ) : canvasserListProgress ? (
                  <div className="geofence-progress">
                    <div className="progress-summary">
                      <div className="progress-headline">
                        <span>
                          Progress {canvasserListProgress.done}/{canvasserListProgress.total}
                        </span>
                        <strong>{canvasserListProgress.percent}%</strong>
                      </div>
                      <div
                        className="progress-bar-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={canvasserListProgress.percent}
                        aria-valuetext={`${canvasserListProgress.done} of ${canvasserListProgress.total} addresses canvassed`}
                      >
                        <div
                          className="progress-bar-fill canvasser-areas-progress-fill"
                          style={{ width: `${canvasserListProgress.percent}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="geofence-panel-lead">No addresses found inside your assigned geofences.</p>
                )}
              </div>
            </aside>
          )}
          {role === 'admin' && (
            <aside
              className={`geofence-panel admin-geofence-panel${
                adminGeofencePanelExpanded ? ' admin-geofence-panel--expanded' : ''
              }`}
            >
              <button
                type="button"
                className="admin-geofence-mobile-strip"
                aria-expanded={adminGeofencePanelExpanded}
                aria-controls="admin-geofence-expandable"
                onClick={() => setAdminGeofencePanelExpanded((open) => !open)}
                aria-label={
                  adminGeofencePanelExpanded
                    ? 'Hide geofence details panel'
                    : 'Show geofence details panel'
                }
              >
                <div className="admin-geofence-mobile-strip-row">
                  <span className="admin-geofence-mobile-strip-title">{geofenceDetailsTitle}</span>
                  <span className="admin-geofence-mobile-strip-chevron" aria-hidden="true">
                    {adminGeofencePanelExpanded ? '▲' : '▼'}
                  </span>
                </div>
              </button>
              <div id="admin-geofence-expandable" className="admin-geofence-expandable">
                <div className="geofence-panel-header">
                  <h3>{geofenceDetailsTitle}</h3>
                  {selectedGeofence ? (
                    <span className="admin-geofence-header-metric">
                      {isGeofenceProgressLoading
                        ? 'Loading...'
                        : geofenceProgress
                          ? `${geofenceProgress.canvassed}/${geofenceProgress.total} canvassed`
                          : '0/0 canvassed'}
                    </span>
                  ) : null}
                  {selectedGeofence ? (
                    <div className="geofence-panel-menu-anchor" ref={geofencePanelMenuRef}>
                      <button
                        type="button"
                        className="geofence-panel-menu-trigger"
                        aria-label="Geofence actions"
                        aria-expanded={geofencePanelMenuOpen}
                        aria-haspopup="menu"
                        aria-controls="geofence-panel-actions-menu"
                        onClick={() => setGeofencePanelMenuOpen((open) => !open)}
                      >
                        <span className="geofence-panel-menu-dots" aria-hidden="true">
                          ⋮
                        </span>
                      </button>
                      {geofencePanelMenuOpen ? (
                        <div
                          id="geofence-panel-actions-menu"
                          className="geofence-panel-actions-menu"
                          role="menu"
                          aria-label="Geofence actions"
                        >
                          <button
                            type="button"
                            className="geofence-panel-menu-item"
                            role="menuitem"
                            disabled={
                              isGeofenceProgressLoading ||
                              !geofenceProgress ||
                              geofenceProgress.remaining <= 0
                            }
                            onClick={() => {
                              setGeofencePanelMenuOpen(false)
                              setMarkAllTargetCanvassed(true)
                              setMarkAllCompleteDialogOpen(true)
                            }}
                          >
                            <GeofenceMarkCanvassedIcon />
                            <span>Mark all addresses canvassed</span>
                          </button>
                          <button
                            type="button"
                            className="geofence-panel-menu-item"
                            role="menuitem"
                            disabled={
                              isGeofenceProgressLoading ||
                              !geofenceProgress ||
                              geofenceProgress.canvassed <= 0
                            }
                            onClick={() => {
                              setGeofencePanelMenuOpen(false)
                              setMarkAllTargetCanvassed(false)
                              setMarkAllCompleteDialogOpen(true)
                            }}
                          >
                            <GeofenceMarkCanvassedIcon />
                            <span>Mark all addresses uncanvassed</span>
                          </button>
                          <button
                            type="button"
                            className="geofence-panel-menu-item geofence-panel-menu-item--danger"
                            role="menuitem"
                            onClick={() => {
                              setGeofencePanelMenuOpen(false)
                              setGeofenceDeleteConfirmId(selectedGeofenceId)
                            }}
                          >
                            <GeofenceTrashIcon />
                            <span>Delete geofence</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {selectedGeofence ? (
                  <>
                  <div className="geofence-progress geofence-progress--inline">
                    {isGeofenceProgressLoading ? (
                      <p>Loading progress...</p>
                    ) : geofenceProgress ? (
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
                    ) : (
                      <p>Select a geofence to see progress.</p>
                    )}
                  </div>
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
                    <div className="geofence-assignee-picker" ref={geofenceAssigneePickerRef}>
                      <button
                        type="button"
                        className="geofence-assignee-picker-trigger"
                        aria-haspopup="listbox"
                        aria-expanded={assigneePickerOpen}
                        aria-controls="geofence-assignee-picker-listbox"
                        onClick={() => setAssigneePickerOpen((open) => !open)}
                      >
                        <span>{selectedAssigneeOption?.label ?? 'Unassigned'}</span>
                        <span className="geofence-assignee-picker-caret" aria-hidden="true">
                          ▾
                        </span>
                      </button>
                      {assigneePickerOpen ? (
                        <div
                          id="geofence-assignee-picker-listbox"
                          className="geofence-assignee-picker-listbox"
                          role="listbox"
                          aria-label="Assign geofence email"
                        >
                          <button
                            type="button"
                            role="option"
                            aria-selected={!geofenceEmailDraft.trim()}
                            className={`geofence-assignee-picker-option${
                              !geofenceEmailDraft.trim()
                                ? ' geofence-assignee-picker-option--selected'
                                : ''
                            }`}
                            onClick={() => {
                              setGeofenceEmailDraft('')
                              setAssigneePickerOpen(false)
                            }}
                          >
                            Unassigned
                          </button>
                          {geofenceAssigneeOptions.map((option) => {
                            const selected =
                              option.value === geofenceEmailDraft.trim().toLowerCase()
                            return (
                              <button
                                key={option.value}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={`geofence-assignee-picker-option${
                                  selected ? ' geofence-assignee-picker-option--selected' : ''
                                }`}
                                onClick={() => {
                                  setGeofenceEmailDraft(option.value)
                                  setAssigneePickerOpen(false)
                                }}
                              >
                                {option.label}
                              </button>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  </label>
                  <div className="geofence-save-row">
                    <button type="button" className="status-button" onClick={() => void saveSelectedGeofence()}>
                      Save geofence
                    </button>
                  </div>
                  </>
                ) : (
                  <p>Draw or click a geofence to edit assignment and view progress.</p>
                )}
                {geofenceMessage && <p className="access-message">{geofenceMessage}</p>}
              </div>
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
              {markAllCompleteDialogOpen && selectedGeofence && (
                <div
                  className="geofence-confirm-backdrop"
                  role="presentation"
                  onClick={(event) => {
                    if (event.target === event.currentTarget && !isMarkingAllComplete) {
                      setMarkAllCompleteDialogOpen(false)
                    }
                  }}
                >
                  <div
                    className="geofence-confirm-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="geofence-mark-all-dialog-title"
                  >
                    <h4 id="geofence-mark-all-dialog-title">
                      Mark all addresses {markAllTargetCanvassed ? 'canvassed' : 'uncanvassed'}?
                    </h4>
                    <p>
                      Every address inside{' '}
                      <span className="geofence-confirm-name">{geofenceDisplayNameForDelete}</span>{' '}
                      will be set to {markAllTargetCanvassed ? 'canvassed' : 'uncanvassed'}. You can
                      still change individual addresses on the map later.
                    </p>
                    <div className="geofence-confirm-actions">
                      <button
                        type="button"
                        className="geofence-confirm-cancel"
                        disabled={isMarkingAllComplete}
                        onClick={() => setMarkAllCompleteDialogOpen(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="geofence-confirm-apply"
                        disabled={isMarkingAllComplete}
                        onClick={() => void confirmMarkAllAddressesInGeofence()}
                      >
                        {isMarkingAllComplete
                          ? 'Updating…'
                          : `Mark all ${markAllTargetCanvassed ? 'canvassed' : 'uncanvassed'}`}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </aside>
          )}
        </section>
      ) : null}
      {role === 'admin' && activeAdminView === 'access' && (
        <section className="admin-panel">
          <div className="admin-panel-header">
            <div>
              <h2>Admin Access Panel</h2>
              <p>Manage who can sign in and what role they have.</p>
            </div>
            <button
              type="button"
              className="status-button"
              onClick={() => {
                setAccessMessage('')
                setAddUserModalOpen(true)
              }}
            >
              Add user
            </button>
          </div>
          {accessMessage && <p className="access-message">{accessMessage}</p>}
          <div className="profiles-table-wrap">
            <table className="profiles-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isProfilesLoading ? (
                  <tr>
                    <td colSpan={5}>Loading access list...</td>
                  </tr>
                ) : (
                  accessRows.map((entry) => {
                    const isEditingUser = editingUserEmail.toLowerCase() === entry.email.toLowerCase()
                    return (
                    <tr key={entry.email}>
                      <td data-label="Name">
                        {isEditingUser ? (
                          <input
                            className="table-email-input"
                            type="text"
                            value={editingUserNameDraft}
                            onChange={(event) => setEditingUserNameDraft(event.target.value)}
                          />
                        ) : (
                          accessDisplayName(entry)
                        )}
                      </td>
                      <td data-label="Email">
                        {isEditingUser ? (
                          <input
                            className="table-email-input"
                            type="email"
                            value={editingUserEmailDraft}
                            onChange={(event) => setEditingUserEmailDraft(event.target.value)}
                          />
                        ) : (
                          <span>{entry.email}</span>
                        )}
                      </td>
                      <td data-label="Role">
                        {isEditingUser ? (
                          <div className="role-edit-toggle" role="radiogroup" aria-label="User role">
                            <button
                              type="button"
                              className={`role-edit-toggle-btn${
                                editingUserRoleDraft === 'canvasser'
                                  ? ' role-edit-toggle-btn--active'
                                  : ''
                              }`}
                              aria-pressed={editingUserRoleDraft === 'canvasser'}
                              disabled={entry.role === 'admin' && adminCount <= 1}
                              onClick={() => setEditingUserRoleDraft('canvasser')}
                            >
                              Canvasser
                            </button>
                            <button
                              type="button"
                              className={`role-edit-toggle-btn${
                                editingUserRoleDraft === 'admin' ? ' role-edit-toggle-btn--active' : ''
                              }`}
                              aria-pressed={editingUserRoleDraft === 'admin'}
                              onClick={() => setEditingUserRoleDraft('admin')}
                            >
                              Admin
                            </button>
                          </div>
                        ) : (
                          <span>{entry.role}</span>
                        )}
                      </td>
                      <td data-label="Status">
                        <span className={`status-pill ${entry.status}`}>{entry.status}</span>
                      </td>
                      <td
                        className={`profiles-actions-cell${isEditingUser ? ' profiles-actions-cell--editing' : ''}`}
                        data-label={isEditingUser ? '' : 'Actions'}
                      >
                        {isEditingUser ? (
                          <div className="table-row-inline-actions">
                            <button
                              type="button"
                              className="row-action-btn"
                              onClick={() => void saveEditedUser(entry.email)}
                            >
                              Save changes
                            </button>
                            <button type="button" className="row-action-btn" onClick={cancelEditUser}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div
                            className="access-row-actions-menu-anchor"
                            ref={openAccessActionsEmail === entry.email ? accessActionsMenuRef : null}
                          >
                            <button
                              type="button"
                              className="access-row-actions-trigger"
                              aria-label="User actions"
                              aria-expanded={openAccessActionsEmail === entry.email}
                              aria-haspopup="menu"
                              aria-controls={`access-row-actions-menu-${entry.email}`}
                              onClick={() =>
                                setOpenAccessActionsEmail((current) =>
                                  current === entry.email ? '' : entry.email,
                                )
                              }
                            >
                              <span className="access-row-actions-dots" aria-hidden="true">
                                ⋮
                              </span>
                            </button>
                            {openAccessActionsEmail === entry.email ? (
                              <div
                                id={`access-row-actions-menu-${entry.email}`}
                                className="access-row-actions-menu"
                                role="menu"
                                aria-label="User actions"
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="access-row-actions-menu-item"
                                  onClick={() => startEditUser(entry)}
                                >
                                  Edit user
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="access-row-actions-menu-item access-row-actions-menu-item--danger"
                                  disabled={entry.role === 'admin' && adminCount <= 1}
                                  onClick={() => {
                                    setOpenAccessActionsEmail('')
                                    void deleteUserAccess(entry.email)
                                  }}
                                >
                                  Delete user
                                </button>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  )})
                )}
              </tbody>
            </table>
          </div>
          {addUserModalOpen ? (
            <div
              className="geofence-confirm-backdrop"
              role="presentation"
              onClick={(event) => {
                if (event.target === event.currentTarget && !isAddingUser) {
                  setAddUserModalOpen(false)
                }
              }}
            >
              <div
                className="geofence-confirm-dialog add-user-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-user-dialog-title"
              >
                <h4 id="add-user-dialog-title">Add user</h4>
                <form className="access-form access-form--modal" onSubmit={(event) => void upsertProfile(event)}>
                  <label>
                    Name
                    <input
                      type="text"
                      placeholder="Full name"
                      value={newProfileName}
                      onChange={(event) => setNewProfileName(event.target.value)}
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      placeholder="Email address"
                      value={newProfileEmail}
                      onChange={(event) => setNewProfileEmail(event.target.value)}
                    />
                  </label>
                  <label>
                    User type
                    <div className="role-edit-toggle add-user-role-toggle" role="radiogroup" aria-label="New user role">
                      <button
                        type="button"
                        className={`role-edit-toggle-btn${
                          newProfileRole === 'canvasser' ? ' role-edit-toggle-btn--active' : ''
                        }`}
                        aria-pressed={newProfileRole === 'canvasser'}
                        onClick={() => setNewProfileRole('canvasser')}
                      >
                        Canvasser
                      </button>
                      <button
                        type="button"
                        className={`role-edit-toggle-btn${
                          newProfileRole === 'admin' ? ' role-edit-toggle-btn--active' : ''
                        }`}
                        aria-pressed={newProfileRole === 'admin'}
                        onClick={() => setNewProfileRole('admin')}
                      >
                        Admin
                      </button>
                    </div>
                  </label>
                  <div className="geofence-confirm-actions">
                    <button
                      type="button"
                      className="geofence-confirm-cancel"
                      disabled={isAddingUser}
                      onClick={() => setAddUserModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="geofence-confirm-apply" disabled={isAddingUser}>
                      {isAddingUser ? 'Adding…' : 'Add user'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ) : null}
        </section>
      )}
    </main>
  )
}

export default App
