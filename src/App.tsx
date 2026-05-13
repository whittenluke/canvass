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
  AdminDashboardContributorRow,
  AdminDashboardEffortSummaryRow,
  AdminGeofenceListProgressRow,
  AdminGeofenceProgressRow,
  AdminMarkGeofenceResultRow,
  AdminMarkGeofenceSignedPetitionResultRow,
  GeofenceProgress,
  GeofenceRow,
  ViewportBounds,
} from './features/app/types'
import {
  ADDRESS_CLUSTER_CROSS_GAP_METERS,
  ADDRESS_EXACT_POINT_CLUSTER_MIN_ZOOM,
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
  clusterAddressesByExactPoint,
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
  GeofenceChevronLeftIcon,
  GeofenceMarkCanvassedIcon,
  GeofencePencilIcon,
  GeofenceTrashIcon,
  MapHelpInfoIcon,
  MapPaneSetup,
  MapStatusLine,
  MapViewportWatcher,
  PasswordEyeIcon,
} from './features/map/MapWorkspace'
import { CollapsibleStreetBlock, NearbyAddressSheet } from './features/canvasser/CanvasserWorkspace'
import './App.css'

type ClusterBadgeStyle = 'todo' | 'canvassed' | 'petition'

/** New icon per marker: Leaflet must not reuse one DivIcon instance across multiple markers. */
function createClusterCountIcon(
  count: number,
  badgeStyle: ClusterBadgeStyle,
  compactHit: boolean,
): L.DivIcon {
  const badgeClass =
    badgeStyle === 'petition'
      ? 'address-cluster-hit__badge address-cluster-hit__badge--all-petition'
      : badgeStyle === 'canvassed'
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

/** v2: key is email + assignments only — not focused area. Sleep/resume restores one map view; switching focus always re-frames. */
const CANVASSER_VIEWPORT_STORAGE_VERSION = 'v2'

function canvasserViewportSessionStorageKey(
  emailNorm: string,
  assignedFenceIdsJoined: string,
): string {
  return `canvasser.mapViewport.${CANVASSER_VIEWPORT_STORAGE_VERSION}:${emailNorm}:${assignedFenceIdsJoined}`
}

type StoredCanvasserViewport = { lat: number; lng: number; zoom: number }

function parseStoredCanvasserViewport(raw: string | null): StoredCanvasserViewport | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredCanvasserViewport
    if (
      typeof parsed.lat !== 'number' ||
      typeof parsed.lng !== 'number' ||
      typeof parsed.zoom !== 'number' ||
      !Number.isFinite(parsed.lat) ||
      !Number.isFinite(parsed.lng) ||
      !Number.isFinite(parsed.zoom)
    ) {
      return null
    }
    if (parsed.lat < -85 || parsed.lat > 85 || parsed.lng < -180 || parsed.lng > 180) return null
    if (parsed.zoom < 1 || parsed.zoom > 22) return null
    return parsed
  } catch {
    return null
  }
}

/** When an admin picks an area from the details list, fit the map to that polygon up to this zoom. */
const ADMIN_AREA_DETAIL_FOCUS_MAX_ZOOM = 17
/** End "exit single area" map latch when viewport is roughly regional or smaller zoom (see effects). */
const ADMIN_MAP_EXIT_AREA_LATCH_MIN_LAT_SPAN = 0.105
const ADMIN_MAP_EXIT_AREA_LATCH_MIN_LNG_SPAN = 0.16
const ADMIN_MAP_EXIT_AREA_LATCH_FAILSAFE_MS = 3200

function App() {
  const [role, setRole] = useState<string>('')
  const [addresses, setAddresses] = useState<AddressRow[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [viewport, setViewport] = useState<ViewportBounds | null>(null)
  const [hitViewportLimit, setHitViewportLimit] = useState(false)
  const [activeAdminView, setActiveAdminView] = useState<'map' | 'access' | 'dashboard'>('map')
  const [geofences, setGeofences] = useState<GeofenceRow[]>([])
  const [selectedGeofenceId, setSelectedGeofenceId] = useState('')
  const [geofenceNameDraft, setGeofenceNameDraft] = useState('')
  const [geofenceEmailDraft, setGeofenceEmailDraft] = useState('')
  const [isEditingGeofenceTitle, setIsEditingGeofenceTitle] = useState(false)
  const [geofenceProgress, setGeofenceProgress] = useState<GeofenceProgress | null>(null)
  const [isGeofenceProgressLoading, setIsGeofenceProgressLoading] = useState(false)
  const [adminGeofenceOverviewRows, setAdminGeofenceOverviewRows] = useState<
    AdminGeofenceListProgressRow[] | null
  >(null)
  const [isAdminGeofenceOverviewLoading, setIsAdminGeofenceOverviewLoading] = useState(false)
  const [adminGeofenceOverviewError, setAdminGeofenceOverviewError] = useState('')
  const [adminDashboardEffort, setAdminDashboardEffort] = useState<AdminDashboardEffortSummaryRow | null>(
    null,
  )
  const [adminDashboardLeaderboard, setAdminDashboardLeaderboard] = useState<AdminDashboardContributorRow[]>(
    [],
  )
  const [adminDashboardLoading, setAdminDashboardLoading] = useState(false)
  const [adminDashboardError, setAdminDashboardError] = useState('')
  const [adminDashboardLeaderboardRange, setAdminDashboardLeaderboardRange] = useState<'all' | '30d'>('all')
  const [geofenceMessage, setGeofenceMessage] = useState('')
  const [geofenceDeleteConfirmId, setGeofenceDeleteConfirmId] = useState<string | null>(null)
  const [isGeofenceDeleting, setIsGeofenceDeleting] = useState(false)
  const [markAllCompleteDialogOpen, setMarkAllCompleteDialogOpen] = useState(false)
  const [isMarkingAllComplete, setIsMarkingAllComplete] = useState(false)
  const [markAllTargetCanvassed, setMarkAllTargetCanvassed] = useState(true)
  const [markAllPetitionDialogOpen, setMarkAllPetitionDialogOpen] = useState(false)
  const [isMarkingAllPetition, setIsMarkingAllPetition] = useState(false)
  const [markAllTargetSigned, setMarkAllTargetSigned] = useState(true)
  const [geofencePanelMenuOpen, setGeofencePanelMenuOpen] = useState(false)
  const geofencePanelMenuRef = useRef<HTMLDivElement>(null)
  const geofenceTitleInputRef = useRef<HTMLInputElement>(null)
  const geofenceTitleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const geofenceDetailDraftsRef = useRef({ name: '', email: '' })
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
  const geofenceAssigneePickerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const [mapReadySequence, setMapReadySequence] = useState(0)
  const [dotsEnabled, setDotsEnabled] = useState(false)
  /** After leaving a selected area (all-areas / map click-out), suppress dots + viewport fetches until zoom-out settles. */
  const [adminExitAreaDetailMapLatch, setAdminExitAreaDetailMapLatch] = useState(false)
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
  /** Admin map + overview: '' = all assignees; otherwise normalized assignee email. */
  const [adminAreaViewerEmailFilter, setAdminAreaViewerEmailFilter] = useState('')
  /** Tracks last assignee filter for map fit on dropdown change only. */
  const prevAdminAreaViewerFilterForMapRef = useRef<string | null>(null)
  const [canvasserAreasPanelExpanded, setCanvasserAreasPanelExpanded] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.matchMedia('(min-width: 901px)').matches
  })
  const [canvasserFocusedGeofenceId, setCanvasserFocusedGeofenceId] = useState('')
  const [canvasserListAreaPickerOpen, setCanvasserListAreaPickerOpen] = useState(false)
  const [canvasserMapHelpOpen, setCanvasserMapHelpOpen] = useState(false)
  const canvasserMapHelpRef = useRef<HTMLDivElement>(null)
  const canvasserListAreaPickerRef = useRef<HTMLDivElement>(null)
  const canvasserAreasPanelRef = useRef<HTMLElement | null>(null)
  /** Block persisting viewport until fit/restore has run (avoids clobbering sessionStorage with default center/zoom before restore). */
  const canvasserAllowViewportPersistRef = useRef(false)
  /** Last framing snapshot: distinguish map remount / assignment change from focus-only (restore vs fitBounds). */
  const canvasserViewportFramingRef = useRef<{
    mapSeq: number
    focus: string
    assignKey: string
  } | null>(null)
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
  const supportHref = role === 'admin' ? '/support/admins' : '/support/canvassers'
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
    pauseViewportFetches: role === 'admin' && adminExitAreaDetailMapLatch,
    onSetAddresses: setAddressesFromViewport,
    onSetHitViewportLimit: setHitViewportLimitFromViewport,
    onSetErrorMessage: setErrorMessageFromViewport,
  })

  useEffect(() => {
    if (role !== 'admin') {
      setAdminExitAreaDetailMapLatch(false)
    }
  }, [role])

  useEffect(() => {
    if (!adminExitAreaDetailMapLatch || role !== 'admin') return
    const timer = window.setTimeout(() => {
      setAdminExitAreaDetailMapLatch(false)
    }, ADMIN_MAP_EXIT_AREA_LATCH_FAILSAFE_MS)
    return () => window.clearTimeout(timer)
  }, [role, adminExitAreaDetailMapLatch])

  useEffect(() => {
    if (!adminExitAreaDetailMapLatch || role !== 'admin' || !viewport) return
    const z = viewport.zoom ?? 0
    const latSpan = viewport.north - viewport.south
    const lngSpan = Math.abs(viewport.east - viewport.west)
    if (
      z < DOTS_VISIBLE_MIN_ZOOM_ADMIN ||
      latSpan >= ADMIN_MAP_EXIT_AREA_LATCH_MIN_LAT_SPAN ||
      lngSpan >= ADMIN_MAP_EXIT_AREA_LATCH_MIN_LNG_SPAN
    ) {
      setAdminExitAreaDetailMapLatch(false)
    }
  }, [role, adminExitAreaDetailMapLatch, viewport])

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
  /** Stable while fence id set unchanged — avoids re-running expensive admin overview RPC on unrelated geofences array churn. */
  const adminGeofenceIdsKey = useMemo(
    () =>
      [...geofences]
        .map((g) => g.id)
        .sort()
        .join('|'),
    [geofences],
  )
  /** Changes when selected fence row meaningfully updates (geometry/name), not when other fences refresh. */
  const selectedGeofenceProgressFingerprint = useMemo(() => {
    if (!selectedGeofenceId) return ''
    const f = geofences.find((x) => x.id === selectedGeofenceId)
    if (!f) return `${selectedGeofenceId}:missing`
    const ring = f.geometry.coordinates[0] ?? []
    let coordChecksum = 0
    for (const pt of ring) {
      coordChecksum += (pt[0] ?? 0) + (pt[1] ?? 0)
    }
    return `${f.id}:${ring.length}:${coordChecksum.toFixed(6)}:${f.name}:${f.assigned_email ?? ''}`
  }, [geofences, selectedGeofenceId])
  const canvasserEffectiveFocusGeofenceId = useMemo(() => {
    if (role !== 'canvasser') return ''
    if (assignedGeofenceIdList.length <= 1) return ''
    const id = canvasserFocusedGeofenceId
    if (!id || !assignedGeofenceIdSet.has(id)) return ''
    return id
  }, [role, assignedGeofenceIdList, assignedGeofenceIdSet, canvasserFocusedGeofenceId])
  const canvasserAreasTitle = useMemo(() => {
    const n = assignedGeofenceIdList.length
    if (n === 0) return 'Assigned areas'
    if (n === 1) {
      const fence = geofences.find((g) => g.id === assignedGeofenceIdList[0])
      const name = fence?.name.trim()
      return name ? name : 'Unnamed area'
    }
    return `${n} areas assigned`
  }, [assignedGeofenceIdList, geofences])
  const adminGeofencesFiltered = useMemo(() => {
    if (role !== 'admin') return geofences
    const filter = adminAreaViewerEmailFilter.trim().toLowerCase()
    if (!filter) return geofences
    return geofences.filter(
      (g) => (g.assigned_email ?? '').trim().toLowerCase() === filter,
    )
  }, [role, geofences, adminAreaViewerEmailFilter])
  const geofencesForMap = useMemo(() => {
    if (role === 'canvasser') {
      return geofences.filter((g) => assignedGeofenceIdSet.has(g.id))
    }
    if (role === 'admin') {
      return adminGeofencesFiltered
    }
    return geofences
  }, [role, geofences, assignedGeofenceIdSet, adminGeofencesFiltered])
  const geofenceDisplayNameForDelete = useMemo(() => {
    if (!selectedGeofence) return ''
    const trimmed = geofenceNameDraft.trim()
    return trimmed || selectedGeofence.name || 'Unnamed area'
  }, [geofenceNameDraft, selectedGeofence])
  const geofenceDetailsTitle = useMemo(() => {
    if (!selectedGeofence) return 'All areas'
    const draft = geofenceNameDraft.trim()
    const persisted = selectedGeofence.name?.trim() ?? ''
    const title = draft || persisted
    return title || 'Unnamed area'
  }, [selectedGeofence, geofenceNameDraft])
  const geofenceCompletionPercent = useMemo(() => {
    if (!geofenceProgress) return 0
    const total = Number(geofenceProgress.total)
    if (!Number.isFinite(total) || total <= 0) return 0
    const canvassed = Number(geofenceProgress.canvassed)
    if (!Number.isFinite(canvassed)) return 0
    return Math.min(100, Math.round((canvassed / total) * 100))
  }, [geofenceProgress])
  const adminGeofenceOverviewDisplay = useMemo(() => {
    if (!adminGeofenceOverviewRows) return []
    const byId = new Map(adminGeofenceOverviewRows.map((r) => [r.geofence_id, r]))
    return adminGeofencesFiltered
      .map((g) => {
        const p = byId.get(g.id)
        const total = p?.total_count ?? 0
        const canvassed = p?.canvassed_count ?? 0
        const pct = total === 0 ? 0 : Math.round((canvassed / total) * 100)
        const name = g.name.trim() || 'Unnamed area'
        return { id: g.id, name, total, canvassed, pct }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [adminGeofencesFiltered, adminGeofenceOverviewRows])

  const fitAdminMapToGeofenceList = useCallback((fences: GeofenceRow[]) => {
    const map = mapRef.current
    if (!map || fences.length === 0) return
    const bounds = L.latLngBounds([])
    for (const fence of fences) {
      const ring = fence.geometry.coordinates[0] ?? []
      for (const [lng, lat] of ring) {
        bounds.extend([lat, lng])
      }
    }
    if (!bounds.isValid()) return
    const pad = 34
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        map.fitBounds(bounds, {
          paddingTopLeft: [pad, pad],
          paddingBottomRight: [pad, pad],
          maxZoom: 16,
          animate: true,
        })
      })
    })
  }, [])

  useEffect(() => {
    if (role !== 'admin') {
      setAdminAreaViewerEmailFilter('')
      prevAdminAreaViewerFilterForMapRef.current = null
    }
  }, [role])

  useEffect(() => {
    if (role !== 'admin') return
    if (!selectedGeofenceId) return
    if (!adminGeofencesFiltered.some((g) => g.id === selectedGeofenceId)) {
      setSelectedGeofenceId('')
      setGeofencePanelMenuOpen(false)
    }
  }, [role, selectedGeofenceId, adminGeofencesFiltered])

  useEffect(() => {
    if (role !== 'admin') return

    const current = adminAreaViewerEmailFilter.trim().toLowerCase()
    const prev = prevAdminAreaViewerFilterForMapRef.current
    if (prev === null) {
      prevAdminAreaViewerFilterForMapRef.current = current
      return
    }
    if (prev === current) return
    prevAdminAreaViewerFilterForMapRef.current = current

    if (adminGeofencesFiltered.length === 0) return
    fitAdminMapToGeofenceList(adminGeofencesFiltered)
  }, [role, adminAreaViewerEmailFilter, adminGeofencesFiltered, fitAdminMapToGeofenceList])

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
  /** Canvassers: only dots inside assigned areas. Admins: all in view, or only inside selected area when dots are on. */
  const addressesForMapDots = useMemo(() => {
    if (role !== 'canvasser') {
      if (role === 'admin' && adminExitAreaDetailMapLatch) {
        return []
      }
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
    if (assignedGeofenceIdList.length > 1 && canvasserEffectiveFocusGeofenceId) {
      const fence = geofences.find((g) => g.id === canvasserEffectiveFocusGeofenceId)
      if (!fence) {
        return []
      }
      return validAddresses.filter((address) =>
        booleanPointInPolygon(point([address.long, address.lat]), fence.geometry),
      )
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
    canvasserEffectiveFocusGeofenceId,
    geofences,
    assignedGeofenceIdSet,
    adminExitAreaDetailMapLatch,
  ])
  const addressClustersForMap = useMemo(() => {
    if (addressesForMapDots.length === 0) return []
    const zoom = viewport?.zoom ?? 13

    if (zoom >= ADDRESS_EXACT_POINT_CLUSTER_MIN_ZOOM) {
      const exact = clusterAddressesByExactPoint(addressesForMapDots)
      return sortClustersSinglesFirst(exact)
    }

    const useProximityClustering =
      role !== 'admin' ||
      !viewport ||
      zoom >= ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM

    if (!useProximityClustering) {
      const cellPixels = zoom <= 14 ? 72 : zoom <= 15 ? 56 : 48
      const raw = clusterAddressesByViewportGrid(addressesForMapDots, viewport, cellPixels)
      return sortClustersSinglesFirst(raw)
    }

    const linked = clusterAddressesByProximity(addressesForMapDots, ADDRESS_CLUSTER_MERGE_METERS)
    const merged = mergeClustersByCrossGap(linked, ADDRESS_CLUSTER_CROSS_GAP_METERS)
    return sortClustersSinglesFirst(merged)
  }, [addressesForMapDots, role, viewport])
  const canvasserListRowsLive = useMemo(() => {
    if (!canvasserListAddresses) return []
    return [...canvasserListAddresses].sort((a, b) =>
      a.full_address.localeCompare(b.full_address, undefined, { numeric: true }),
    )
  }, [canvasserListAddresses])
  const canvasserListProgress = useMemo(() => {
    const rows = canvasserListRowsLive
    if (rows.length === 0) return null
    const canvassedDone = rows.filter((r) => r.canvassed).length
    const petitionDone = rows.filter((r) => r.signed_petition).length
    const total = rows.length
    return {
      canvassedDone,
      petitionDone,
      total,
      canvassedPercent: Math.round((canvassedDone / total) * 100),
      petitionPercent: Math.round((petitionDone / total) * 100),
    }
  }, [canvasserListRowsLive])
  const canvasserDrawerOverallProgress = useMemo(
    () =>
      canvasserListProgress ?? {
        canvassedDone: 0,
        petitionDone: 0,
        total: 0,
        canvassedPercent: 0,
        petitionPercent: 0,
      },
    [canvasserListProgress],
  )
  const canvasserProgressByGeofence = useMemo(() => {
    if (role !== 'canvasser') return []
    const fences = geofences.filter((g) => assignedGeofenceIdSet.has(g.id))
    const rows = canvasserListRowsLive
    return fences
      .map((fence) => {
        const inFence = rows.filter((addr) =>
          booleanPointInPolygon(point([addr.long, addr.lat]), fence.geometry),
        )
        const total = inFence.length
        const canvassedDone = inFence.filter((r) => r.canvassed).length
        const petitionDone = inFence.filter((r) => r.signed_petition).length
        const canvassedPercent = total === 0 ? 0 : Math.round((canvassedDone / total) * 100)
        const petitionPercent = total === 0 ? 0 : Math.round((petitionDone / total) * 100)
        return {
          id: fence.id,
          name: fence.name.trim() || 'Unnamed area',
          canvassedDone,
          petitionDone,
          total,
          canvassedPercent,
          petitionPercent,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }, [role, geofences, assignedGeofenceIdSet, canvasserListRowsLive])
  const canvasserListAreaPickerLabel = useMemo(() => {
    if (!canvasserEffectiveFocusGeofenceId) return 'All areas'
    return (
      canvasserProgressByGeofence.find((a) => a.id === canvasserEffectiveFocusGeofenceId)?.name ??
      'Selected area'
    )
  }, [canvasserEffectiveFocusGeofenceId, canvasserProgressByGeofence])
  const canvasserRowsForUi = useMemo(() => {
    if (role !== 'canvasser' || !canvasserEffectiveFocusGeofenceId) {
      return canvasserListRowsLive
    }
    const fence = geofences.find((g) => g.id === canvasserEffectiveFocusGeofenceId)
    if (!fence) {
      return canvasserListRowsLive
    }
    return canvasserListRowsLive.filter((addr) =>
      booleanPointInPolygon(point([addr.long, addr.lat]), fence.geometry),
    )
  }, [role, canvasserEffectiveFocusGeofenceId, geofences, canvasserListRowsLive])
  const canvasserStreetGroupsForList = useMemo(
    () => buildStreetGroups(canvasserRowsForUi),
    [canvasserRowsForUi],
  )
  const canvasserDisplayProgress = useMemo(() => {
    if (role !== 'canvasser') return null
    if (!canvasserEffectiveFocusGeofenceId) {
      return canvasserListProgress
    }
    const z = canvasserProgressByGeofence.find((x) => x.id === canvasserEffectiveFocusGeofenceId)
    if (!z) {
      return canvasserListProgress
    }
    return {
      canvassedDone: z.canvassedDone,
      petitionDone: z.petitionDone,
      total: z.total,
      canvassedPercent: z.canvassedPercent,
      petitionPercent: z.petitionPercent,
    }
  }, [role, canvasserEffectiveFocusGeofenceId, canvasserListProgress, canvasserProgressByGeofence])
  const canvasserAssignedFenceIdsKey = useMemo(
    () => [...assignedGeofenceIdList].sort().join('|'),
    [assignedGeofenceIdList],
  )
  const persistCanvasserMapViewport = useCallback(
    (next: ViewportBounds) => {
      if (role !== 'canvasser') return
      if (canvasserUiView !== 'map') return
      if (!canvasserAllowViewportPersistRef.current) return
      if (!canvasserAssignedFenceIdsKey) return
      const emailNorm = sessionEmail || '(no-email)'
      const storageKey = canvasserViewportSessionStorageKey(emailNorm, canvasserAssignedFenceIdsKey)
      const payload: StoredCanvasserViewport = {
        lat: (next.south + next.north) / 2,
        lng: (next.west + next.east) / 2,
        zoom: next.zoom,
      }
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(payload))
      } catch {
        /* quota / private mode */
      }
    },
    [role, canvasserUiView, sessionEmail, canvasserAssignedFenceIdsKey],
  )
  const onMapViewportChange = useCallback(
    (next: ViewportBounds) => {
      setViewport(next)
      persistCanvasserMapViewport(next)
    },
    [persistCanvasserMapViewport],
  )

  // Persist immediately when the tab goes hidden — reduces races where sleep locks before Leaflet emits moveend.
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (role !== 'canvasser' || canvasserUiView !== 'map') return

    const flushIfGoingAway = () => {
      if (document.visibilityState !== 'hidden') return
      const map = mapRef.current
      if (!map || !canvasserAllowViewportPersistRef.current) return
      const b = map.getBounds()
      persistCanvasserMapViewport({
        south: b.getSouth(),
        west: b.getWest(),
        north: b.getNorth(),
        east: b.getEast(),
        zoom: map.getZoom(),
      })
    }

    document.addEventListener('visibilitychange', flushIfGoingAway)
    window.addEventListener('pagehide', flushIfGoingAway)
    return () => {
      document.removeEventListener('visibilitychange', flushIfGoingAway)
      window.removeEventListener('pagehide', flushIfGoingAway)
    }
  }, [role, canvasserUiView, persistCanvasserMapViewport])

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
  const adminAreaViewerAssigneeSelectOptions = useMemo(() => {
    const emails = new Set<string>()
    for (const g of geofences) {
      const e = (g.assigned_email ?? '').trim().toLowerCase()
      if (e) emails.add(e)
    }
    for (const row of accessRows) {
      if (row.role !== 'canvasser') continue
      const e = row.email.trim().toLowerCase()
      if (e) emails.add(e)
    }
    return Array.from(emails)
      .sort()
      .map((value) => {
        const access = accessRows.find((a) => a.email.trim().toLowerCase() === value)
        return {
          value,
          label: access ? accessDisplayName(access) : value,
        }
      })
  }, [geofences, accessRows])
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
        setCanvasserAreasPanelExpanded(false)
      } else {
        setAdminGeofencePanelExpanded(true)
        setCanvasserAreasPanelExpanded(true)
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
          .select('id,full_address,lat,long,canvassed,signed_petition')
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
    if (!isEditingGeofenceTitle) {
      setGeofenceNameDraft(selectedGeofence.name ?? '')
    }
    setGeofenceEmailDraft(selectedGeofence.assigned_email ?? '')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedGeofence, isEditingGeofenceTitle])

  useEffect(() => {
    setIsEditingGeofenceTitle(false)
  }, [selectedGeofenceId])

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
            petitionSigned: row?.petition_signed_count ?? 0,
            petitionRemaining: row?.petition_remaining_count ?? 0,
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
  }, [selectedGeofenceProgressFingerprint, supabase])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- admin overview when no fence selected */
    if (role !== 'admin') {
      setAdminGeofenceOverviewRows(null)
      setIsAdminGeofenceOverviewLoading(false)
      setAdminGeofenceOverviewError('')
      return
    }
    if (selectedGeofenceId) {
      setAdminGeofenceOverviewRows(null)
      setIsAdminGeofenceOverviewLoading(false)
      setAdminGeofenceOverviewError('')
      return
    }
    if (!supabase || adminGeofenceIdsKey === '') {
      setAdminGeofenceOverviewRows(null)
      setIsAdminGeofenceOverviewLoading(false)
      setAdminGeofenceOverviewError('')
      return
    }
    let cancelled = false
    const run = async () => {
      setIsAdminGeofenceOverviewLoading(true)
      setAdminGeofenceOverviewError('')
      try {
        const { data, error } = await supabase.rpc('admin_list_geofence_progress')
        if (!cancelled && !error && Array.isArray(data)) {
          const rows: AdminGeofenceListProgressRow[] = (data as AdminGeofenceListProgressRow[]).map(
            (r) => ({
              geofence_id: String(r.geofence_id),
              total_count: r.total_count,
              canvassed_count: r.canvassed_count,
              remaining_count: r.remaining_count,
              petition_signed_count: r.petition_signed_count ?? 0,
              petition_remaining_count: r.petition_remaining_count ?? 0,
            }),
          )
          setAdminGeofenceOverviewRows(rows)
        } else {
          const fallbackRows: AdminGeofenceListProgressRow[] = await Promise.all(
            geofences.map(async (g) => {
              const { data: d, error: e } = await supabase.rpc('admin_get_geofence_progress', {
                p_geofence_id: g.id,
              })
              if (e) {
                const p = await fetchAddressStatsInsidePolygon(supabase, g.geometry)
                return {
                  geofence_id: g.id,
                  total_count: p.total,
                  canvassed_count: p.canvassed,
                  remaining_count: p.remaining,
                  petition_signed_count: p.petitionSigned,
                  petition_remaining_count: p.petitionRemaining,
                }
              }
              const row = ((d as AdminGeofenceProgressRow[] | null) ?? [])[0]
              return {
                geofence_id: g.id,
                total_count: row?.total_count ?? 0,
                canvassed_count: row?.canvassed_count ?? 0,
                remaining_count: row?.remaining_count ?? 0,
                petition_signed_count: row?.petition_signed_count ?? 0,
                petition_remaining_count: row?.petition_remaining_count ?? 0,
              }
            }),
          )
          if (!cancelled) {
            setAdminGeofenceOverviewRows(fallbackRows)
          }
        }
      } catch (e) {
        if (!cancelled) {
          setAdminGeofenceOverviewRows(null)
          setAdminGeofenceOverviewError(
            e instanceof Error ? e.message : 'Failed to load area progress',
          )
        }
      } finally {
        if (!cancelled) {
          setIsAdminGeofenceOverviewLoading(false)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- overview triggers on catalog id set only; run() reads latest geofences from closure when idsKey/role/selection changes
  }, [role, selectedGeofenceId, adminGeofenceIdsKey, supabase])

  useEffect(() => {
    if (role !== 'admin' || activeAdminView !== 'dashboard' || !supabase) {
      return
    }
    let cancelled = false
    const toNum = (v: unknown): number => {
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
      }
      return 0
    }
    const run = async () => {
      setAdminDashboardLoading(true)
      setAdminDashboardError('')
      const pSince =
        adminDashboardLeaderboardRange === '30d'
          ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
          : null
      try {
        const [sumRes, boardRes] = await Promise.all([
          supabase.rpc('admin_dashboard_effort_summary'),
          supabase.rpc('admin_dashboard_contributor_leaderboard', { p_since: pSince }),
        ])
        if (cancelled) return
        if (sumRes.error) {
          setAdminDashboardError(sumRes.error.message)
          setAdminDashboardEffort(null)
        } else {
          const raw = Array.isArray(sumRes.data) ? sumRes.data[0] : null
          if (raw && typeof raw === 'object') {
            const o = raw as Record<string, unknown>
            setAdminDashboardEffort({
              total_addresses_in_areas: toNum(o.total_addresses_in_areas),
              canvassed_count: toNum(o.canvassed_count),
              petition_signed_count: toNum(o.petition_signed_count),
            })
          } else {
            setAdminDashboardEffort({
              total_addresses_in_areas: 0,
              canvassed_count: 0,
              petition_signed_count: 0,
            })
          }
        }
        if (boardRes.error) {
          setAdminDashboardError((prev) =>
            prev ? `${prev}; ${boardRes.error.message}` : boardRes.error.message,
          )
          setAdminDashboardLeaderboard([])
        } else {
          const rows = Array.isArray(boardRes.data) ? boardRes.data : []
          setAdminDashboardLeaderboard(
            rows.map((r) => {
              const o = r as Record<string, unknown>
              return {
                actor_id: String(o.actor_id ?? ''),
                actor_email: String(o.actor_email ?? ''),
                actor_role: String(o.actor_role ?? ''),
                canvassed_marks: toNum(o.canvassed_marks),
                petition_marks: toNum(o.petition_marks),
              }
            }),
          )
        }
      } catch (e) {
        if (!cancelled) {
          setAdminDashboardEffort(null)
          setAdminDashboardLeaderboard([])
          setAdminDashboardError(e instanceof Error ? e.message : 'Failed to load dashboard')
        }
      } finally {
        if (!cancelled) {
          setAdminDashboardLoading(false)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [role, activeAdminView, supabase, adminDashboardLeaderboardRange])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reset panel/dialog state when fence changes */
    setMarkAllCompleteDialogOpen(false)
    setMarkAllPetitionDialogOpen(false)
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
    if (role !== 'canvasser' || canvasserUiView !== 'list') {
      setCanvasserListAreaPickerOpen(false)
    }
  }, [role, canvasserUiView])

  useEffect(() => {
    if (!canvasserListAreaPickerOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const el = canvasserListAreaPickerRef.current
      if (el && !el.contains(event.target as Node)) {
        setCanvasserListAreaPickerOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCanvasserListAreaPickerOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [canvasserListAreaPickerOpen])

  useEffect(() => {
    if (!mapRef.current) return
    // Leaflet can leave gray tile artifacts after layout changes that resize the map pane.
    // Canvasser areas drawer is overlaid on the map without changing .map-panel size — skipping
    // invalidateSize there avoids a small first-open map nudge from redundant Leaflet relayout.
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
      canvasserAllowViewportPersistRef.current = false
      canvasserViewportFramingRef.current = null
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

    const fencesToFit = canvasserEffectiveFocusGeofenceId
      ? assignedFences.filter((g) => g.id === canvasserEffectiveFocusGeofenceId)
      : assignedFences
    if (fencesToFit.length === 0) {
      return
    }

    const bounds = L.latLngBounds([])
    fencesToFit.forEach((fence) => {
      const ring = fence.geometry.coordinates[0] ?? []
      ring.forEach(([lng, lat]) => {
        bounds.extend([lat, lng])
      })
    })
    if (!bounds.isValid()) {
      return
    }

    const emailNorm = sessionEmail || '(no-email)'
    const storageKey = canvasserViewportSessionStorageKey(emailNorm, canvasserAssignedFenceIdsKey)

    const prevFraming = canvasserViewportFramingRef.current
    const mapSeqChanged = !prevFraming || prevFraming.mapSeq !== mapReadySequence
    const focusChanged =
      !!prevFraming && prevFraming.focus !== canvasserEffectiveFocusGeofenceId
    const assignChanged =
      !!prevFraming && prevFraming.assignKey !== canvasserAssignedFenceIdsKey

    canvasserViewportFramingRef.current = {
      mapSeq: mapReadySequence,
      focus: canvasserEffectiveFocusGeofenceId,
      assignKey: canvasserAssignedFenceIdsKey,
    }

    canvasserAllowViewportPersistRef.current = false

    const runFitBounds = () => {
      const pad = 34
      // Mobile: canvasser drawer overlays the map bottom (see App.css max-width 900px).
      // Symmetric padding centers in the full pane including the occluded strip — bias bottom padding
      // so the fitted bounds sit in the visible map area.
      const mobileOverlay =
        typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches
      const panelBottomInset = mobileOverlay
        ? canvasserAreasPanelRef.current?.offsetHeight ?? 0
        : 0
      map.fitBounds(bounds, {
        paddingTopLeft: [pad, pad],
        paddingBottomRight: [pad, pad + panelBottomInset],
        maxZoom: 16,
      })
    }

    const tryRestoreSavedViewport = (): boolean => {
      let raw: string | null
      try {
        raw = sessionStorage.getItem(storageKey)
      } catch {
        return false
      }
      const parsed = parseStoredCanvasserViewport(raw)
      if (!parsed) return false
      map.setView([parsed.lat, parsed.lng], parsed.zoom, { animate: false })
      return true
    }

    // Wait one frame after map/tab mount so Leaflet has final dimensions.
    // Restore after map remount or assignment change (same storage key = sleep / tab revive).
    // Focus-only change on the same map: fitBounds only — no per-area zoom memory in sessionStorage.
    if (!mapSeqChanged && !focusChanged && !assignChanged) {
      canvasserAllowViewportPersistRef.current = true
      return () => {}
    }

    let persistUnlockRaf = 0
    const raf = window.requestAnimationFrame(() => {
      if (focusChanged && !mapSeqChanged) {
        runFitBounds()
      } else {
        const restored = tryRestoreSavedViewport()
        if (!restored) {
          runFitBounds()
        }
      }
      persistUnlockRaf = window.requestAnimationFrame(() => {
        canvasserAllowViewportPersistRef.current = true
      })
    })
    return () => {
      window.cancelAnimationFrame(raf)
      window.cancelAnimationFrame(persistUnlockRaf)
      canvasserAllowViewportPersistRef.current = false
    }
  }, [
    role,
    canvasserUiView,
    sessionEmail,
    canvasserAssignedFenceIdsKey,
    assignedGeofenceIdSet,
    canvasserEffectiveFocusGeofenceId,
    geofences,
    mapReadySequence,
    assignedGeofenceIdList.length,
  ])

  const centerPoint = useMemo<[number, number]>(() => RURAL_HALL_CENTER, [])
  const isCloseZoom = (viewport?.zoom ?? 13) >= ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM
  const dotsVisibleMinZoom = role === 'admin' ? DOTS_VISIBLE_MIN_ZOOM_ADMIN : DOTS_VISIBLE_MIN_ZOOM_CANVASSER
  const showAddressDots =
    dotsEnabled &&
    (viewport?.zoom ?? 13) >= dotsVisibleMinZoom &&
    !(role === 'admin' && adminExitAreaDetailMapLatch)

  const patchCanvasserListAddress = useCallback((addressId: string, patch: Partial<AddressRow>) => {
    setCanvasserListAddresses((current) => {
      if (!current) return current
      let hit = false
      const next = current.map((row) => {
        if (row.id !== addressId) return row
        hit = true
        return { ...row, ...patch }
      })
      return hit ? next : current
    })
  }, [])

  const restoreCanvasserListAddress = useCallback((row: AddressRow) => {
    setCanvasserListAddresses((current) => {
      if (!current) return current
      let hit = false
      const next = current.map((item) => {
        if (item.id !== row.id) return item
        hit = true
        return { ...row }
      })
      return hit ? next : current
    })
  }, [])

  /** Optimistic admin "all areas" overview rows when no single fence is selected in the panel. */
  const patchAdminGeofenceOverviewForFences = useCallback(
    (
      fenceIds: string[],
      deltas: { canvassedDelta?: number; petitionSignedDelta?: number },
    ) => {
      if (fenceIds.length === 0) return
      const idSet = new Set(fenceIds)
      setAdminGeofenceOverviewRows((rows) => {
        if (!rows) return rows
        let touched = false
        const next = rows.map((r) => {
          if (!idSet.has(r.geofence_id)) return r
          touched = true
          let nextRow = { ...r }
          if (deltas.petitionSignedDelta !== undefined && deltas.petitionSignedDelta !== 0) {
            const signed = Math.max(
              0,
              Math.min(
                nextRow.total_count,
                (nextRow.petition_signed_count ?? 0) + deltas.petitionSignedDelta,
              ),
            )
            nextRow = {
              ...nextRow,
              petition_signed_count: signed,
              petition_remaining_count: Math.max(0, nextRow.total_count - signed),
            }
          }
          if (deltas.canvassedDelta !== undefined && deltas.canvassedDelta !== 0) {
            const cv = Math.max(
              0,
              Math.min(
                nextRow.total_count,
                (nextRow.canvassed_count ?? 0) + deltas.canvassedDelta,
              ),
            )
            nextRow = {
              ...nextRow,
              canvassed_count: cv,
              remaining_count: Math.max(0, nextRow.total_count - cv),
            }
          }
          return nextRow
        })
        return touched ? next : rows
      })
    },
    [],
  )

  const toggleCanvassed = async (address: AddressRow) => {
    if (!supabase) {
      setErrorMessage(missingSupabaseConfig)
      return
    }

    if (role !== 'admin' && role !== 'canvasser') {
      setErrorMessage('You do not have permission to update addresses.')
      return
    }

    const nextState = !address.canvassed

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

    const overviewFenceIds =
      role === 'admin' && !selectedGeofenceId
        ? geofences
            .filter((g) => booleanPointInPolygon(point([address.long, address.lat]), g.geometry))
            .map((g) => g.id)
        : []

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

    if (overviewFenceIds.length > 0) {
      patchAdminGeofenceOverviewForFences(overviewFenceIds, {
        canvassedDelta: nextState ? 1 : -1,
      })
    }

    setAddresses((current) =>
      current.map((item) =>
        item.id === address.id ? { ...item, canvassed: nextState } : item,
      ),
    )
    if (role === 'canvasser') {
      patchCanvasserListAddress(address.id, { canvassed: nextState })
    }

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
      if (overviewFenceIds.length > 0) {
        patchAdminGeofenceOverviewForFences(overviewFenceIds, {
          canvassedDelta: nextState ? -1 : 1,
        })
      }
      setAddresses((current) =>
        current.map((item) =>
          item.id === address.id ? { ...item, canvassed: address.canvassed } : item,
        ),
      )
      if (role === 'canvasser') {
        patchCanvasserListAddress(address.id, { canvassed: address.canvassed })
      }
      setErrorMessage(error.message)
    }
  }

  const toggleSignedPetition = async (
    address: AddressRow,
    options?: { fromAddressMapPopup?: boolean },
  ) => {
    if (!supabase) {
      setErrorMessage(missingSupabaseConfig)
      return
    }

    if (role !== 'admin' && role !== 'canvasser') {
      setErrorMessage('You do not have permission to update addresses.')
      return
    }

    const nextState = !address.signed_petition
    const fromMapPopup = options?.fromAddressMapPopup === true
    const closePopupAfterSuccess =
      fromMapPopup && role === 'canvasser' && nextState === true

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

    const overviewFenceIds =
      role === 'admin' && !selectedGeofenceId
        ? geofences
            .filter((g) => booleanPointInPolygon(point([address.long, address.lat]), g.geometry))
            .map((g) => g.id)
        : []

    const autoCanvassWithPetition =
      role === 'canvasser' && nextState === true && !address.canvassed

    const restoreAddressRow = () => {
      setAddresses((current) =>
        current.map((item) =>
          item.id === address.id
            ? {
                ...item,
                canvassed: address.canvassed,
                signed_petition: address.signed_petition,
              }
            : item,
        ),
      )
      if (role === 'canvasser') {
        restoreCanvasserListAddress(address)
      }
    }

    if (autoCanvassWithPetition) {
      setAddresses((current) =>
        current.map((item) =>
          item.id === address.id
            ? { ...item, canvassed: true, signed_petition: true }
            : item,
        ),
      )
      patchCanvasserListAddress(address.id, { canvassed: true, signed_petition: true })

      const { error: canvassError } = await supabase.rpc('canvasser_set_address_canvassed', {
        p_address_id: address.id,
        p_canvassed: true,
      })
      if (canvassError) {
        restoreAddressRow()
        setErrorMessage(canvassError.message)
        return
      }

      const { error: petitionError } = await supabase.rpc('canvasser_set_address_signed_petition', {
        p_address_id: address.id,
        p_signed: true,
      })
      if (petitionError) {
        const { error: revertCanvassError } = await supabase.rpc('canvasser_set_address_canvassed', {
          p_address_id: address.id,
          p_canvassed: false,
        })
        restoreAddressRow()
        setErrorMessage(
          revertCanvassError
            ? `${petitionError.message} (Could not revert canvassed state: ${revertCanvassError.message}.)`
            : petitionError.message,
        )
        return
      }

      if (closePopupAfterSuccess) {
        mapRef.current?.closePopup()
        setAddressPopupOpenId(null)
      }
      return
    }

    if (addressIsInsideSelectedGeofence) {
      setGeofenceProgress((current) => {
        if (!current) return current
        const nextSigned = current.petitionSigned + (nextState ? 1 : -1)
        return {
          ...current,
          petitionSigned: Math.max(0, nextSigned),
          petitionRemaining: Math.max(current.total - Math.max(0, nextSigned), 0),
        }
      })
    }

    if (overviewFenceIds.length > 0) {
      patchAdminGeofenceOverviewForFences(overviewFenceIds, {
        petitionSignedDelta: nextState ? 1 : -1,
      })
    }

    setAddresses((current) =>
      current.map((item) =>
        item.id === address.id ? { ...item, signed_petition: nextState } : item,
      ),
    )
    if (role === 'canvasser') {
      patchCanvasserListAddress(address.id, { signed_petition: nextState })
    }

    const { error } =
      role === 'admin'
        ? await supabase.rpc('admin_set_address_signed_petition', {
            p_address_id: address.id,
            p_signed: nextState,
          })
        : await supabase.rpc('canvasser_set_address_signed_petition', {
            p_address_id: address.id,
            p_signed: nextState,
          })

    if (error) {
      if (addressIsInsideSelectedGeofence) {
        setGeofenceProgress((current) => {
          if (!current) return current
          const revertedSigned = current.petitionSigned + (address.signed_petition ? 1 : -1)
          return {
            ...current,
            petitionSigned: Math.max(0, revertedSigned),
            petitionRemaining: Math.max(current.total - Math.max(0, revertedSigned), 0),
          }
        })
      }
      if (overviewFenceIds.length > 0) {
        patchAdminGeofenceOverviewForFences(overviewFenceIds, {
          petitionSignedDelta: nextState ? -1 : 1,
        })
      }
      setAddresses((current) =>
        current.map((item) =>
          item.id === address.id ? { ...item, signed_petition: address.signed_petition } : item,
        ),
      )
      if (role === 'canvasser') {
        patchCanvasserListAddress(address.id, { signed_petition: address.signed_petition })
      }
      setErrorMessage(error.message)
      return
    }

    if (closePopupAfterSuccess) {
      mapRef.current?.closePopup()
      setAddressPopupOpenId(null)
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

  const confirmMarkAllPetitionInGeofence = async () => {
    if (!supabase || !selectedGeofence || role !== 'admin') return
    setIsMarkingAllPetition(true)
    setGeofenceMessage('')
    try {
      const { data, error } = await supabase.rpc('admin_mark_geofence_addresses_signed_petition', {
        p_geofence_id: selectedGeofence.id,
        p_signed: markAllTargetSigned,
      })
      if (error) {
        setGeofenceMessage(error.message)
        try {
          const p = await fetchAddressStatsInsidePolygon(supabase, selectedGeofence.geometry)
          setGeofenceProgress(p)
        } catch {
          /* ignore */
        }
        setMarkAllPetitionDialogOpen(false)
        return
      }
      const row = ((data as AdminMarkGeofenceSignedPetitionResultRow[] | null) ?? [])[0]
      const updatedCount = row?.updated_count ?? 0
      if (updatedCount === 0) {
        setGeofenceMessage(
          markAllTargetSigned
            ? 'Every address in this area already has a signed petition.'
            : 'No addresses in this area have a petition signature to clear.',
        )
        setMarkAllPetitionDialogOpen(false)
        return
      }
      setAddresses((current) =>
        current.map((item) =>
          booleanPointInPolygon(point([item.long, item.lat]), selectedGeofence.geometry)
            ? { ...item, signed_petition: markAllTargetSigned }
            : item,
        ),
      )
      setGeofenceProgress((prev) =>
        prev
          ? markAllTargetSigned
            ? { ...prev, petitionSigned: prev.total, petitionRemaining: 0 }
            : { ...prev, petitionSigned: 0, petitionRemaining: prev.total }
          : prev,
      )
      setGeofenceMessage(
        `Updated petition status for ${updatedCount} address${updatedCount === 1 ? '' : 'es'}.`,
      )
      setMarkAllPetitionDialogOpen(false)
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
      setIsMarkingAllPetition(false)
    }
  }

  const handleGeofenceCreated = async (geometry: GeoJSON.Polygon) => {
    if (!supabase || role !== 'admin') return
    const { data, error } = await supabase.rpc('admin_insert_geofence', {
      p_name: 'New area',
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

  const flushGeofenceTitleDebounce = useCallback(() => {
    if (geofenceTitleDebounceRef.current) {
      clearTimeout(geofenceTitleDebounceRef.current)
      geofenceTitleDebounceRef.current = null
    }
  }, [])

  const persistSelectedGeofenceDetails = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!supabase || !selectedGeofenceId || role !== 'admin') return false
      const name = geofenceDetailDraftsRef.current.name.trim() || 'Unnamed area'
      const assignedEmail = geofenceDetailDraftsRef.current.email.trim().toLowerCase() || null
      const { error } = await supabase.rpc('admin_update_geofence_details', {
        p_geofence_id: selectedGeofenceId,
        p_name: name,
        p_assigned_email: assignedEmail ?? '',
      })
      if (error) {
        setGeofenceMessage(error.message)
        return false
      }
      setGeofences((current) =>
        current.map((fence) =>
          fence.id === selectedGeofenceId ? { ...fence, name, assigned_email: assignedEmail } : fence,
        ),
      )
      if (!opts?.silent) setGeofenceMessage('Area details saved.')
      return true
    },
    [supabase, selectedGeofenceId, role],
  )

  const commitGeofenceTitleEdit = useCallback(
    async (opts: { silent: boolean }) => {
      flushGeofenceTitleDebounce()
      geofenceDetailDraftsRef.current = { name: geofenceNameDraft, email: geofenceEmailDraft }
      const trimmed = geofenceNameDraft.trim() || 'Unnamed area'
      const persisted = (selectedGeofence?.name ?? '').trim() || 'Unnamed area'
      if (trimmed !== persisted) {
        const ok = await persistSelectedGeofenceDetails({ silent: opts.silent })
        if (!ok) return
      }
      setIsEditingGeofenceTitle(false)
    },
    [
      flushGeofenceTitleDebounce,
      geofenceNameDraft,
      geofenceEmailDraft,
      selectedGeofence?.name,
      persistSelectedGeofenceDetails,
    ],
  )

  const cancelGeofenceTitleEdit = useCallback(() => {
    flushGeofenceTitleDebounce()
    setGeofenceNameDraft(selectedGeofence?.name ?? '')
    setIsEditingGeofenceTitle(false)
  }, [flushGeofenceTitleDebounce, selectedGeofence?.name])

  const startGeofenceTitleEdit = useCallback(() => {
    setGeofencePanelMenuOpen(false)
    setIsEditingGeofenceTitle(true)
  }, [])

  const saveSelectedGeofence = useCallback(async () => {
    flushGeofenceTitleDebounce()
    geofenceDetailDraftsRef.current = { name: geofenceNameDraft, email: geofenceEmailDraft }
    await persistSelectedGeofenceDetails({ silent: false })
  }, [flushGeofenceTitleDebounce, geofenceNameDraft, geofenceEmailDraft, persistSelectedGeofenceDetails])

  useEffect(() => {
    geofenceDetailDraftsRef.current = { name: geofenceNameDraft, email: geofenceEmailDraft }
  }, [geofenceNameDraft, geofenceEmailDraft])

  useEffect(() => {
    if (!isEditingGeofenceTitle || !selectedGeofenceId || role !== 'admin') return
    const trimmed = geofenceNameDraft.trim() || 'Unnamed area'
    const persisted = (selectedGeofence?.name ?? '').trim() || 'Unnamed area'
    if (trimmed === persisted) {
      flushGeofenceTitleDebounce()
      return
    }
    geofenceTitleDebounceRef.current = setTimeout(() => {
      geofenceTitleDebounceRef.current = null
      void persistSelectedGeofenceDetails({ silent: true })
    }, 700)
    return () => {
      flushGeofenceTitleDebounce()
    }
  }, [
    isEditingGeofenceTitle,
    selectedGeofenceId,
    role,
    geofenceNameDraft,
    selectedGeofence?.name,
    flushGeofenceTitleDebounce,
    persistSelectedGeofenceDetails,
  ])

  useEffect(() => {
    if (!isEditingGeofenceTitle) return
    const id = window.requestAnimationFrame(() => {
      const el = geofenceTitleInputRef.current
      el?.focus()
      el?.select()
    })
    return () => window.cancelAnimationFrame(id)
  }, [isEditingGeofenceTitle])

  const confirmGeofenceDelete = async () => {
    if (!selectedGeofenceId || role !== 'admin') return
    setIsGeofenceDeleting(true)
    const id = selectedGeofenceId
    const ok = await handleGeofenceDeleted([id])
    setIsGeofenceDeleting(false)
    if (ok) {
      setGeofenceNameDraft('')
      setGeofenceEmailDraft('')
      setGeofenceMessage('Area deleted.')
    }
  }

  const fitAdminMapToFence = (fence: GeofenceRow) => {
    const map = mapRef.current
    if (!map) return
    const ring = fence.geometry.coordinates[0] ?? []
    if (ring.length === 0) return
    const bounds = L.latLngBounds([])
    ring.forEach(([lng, lat]) => {
      bounds.extend([lat, lng])
    })
    if (!bounds.isValid()) return
    const pad = 34
    map.fitBounds(bounds, {
      paddingTopLeft: [pad, pad],
      paddingBottomRight: [pad, pad],
      maxZoom: ADMIN_AREA_DETAIL_FOCUS_MAX_ZOOM,
      animate: true,
    })
  }

  const selectGeofenceId = (id: string, options?: { focusOnMap?: boolean }) => {
    setGeofenceDeleteConfirmId(null)
    if (role === 'admin' && id) {
      setAdminExitAreaDetailMapLatch(false)
    }
    if (role === 'admin' && !id) {
      setAdminExitAreaDetailMapLatch(true)
    }
    setSelectedGeofenceId(id)
    if (role === 'admin') {
      setAdminGeofencePanelExpanded(true)
    }
    if (role === 'admin' && options?.focusOnMap && id) {
      const fence = geofences.find((g) => g.id === id)
      if (fence) {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            fitAdminMapToFence(fence)
          })
        })
      }
    } else if (role === 'admin' && !id) {
      fitAdminMapToGeofenceList(adminGeofencesFiltered)
    }
  }

  const handleGeofenceMapPick = (id: string) => {
    if (role === 'admin') {
      selectGeofenceId(id, { focusOnMap: true })
      return
    }
    if (role === 'canvasser') {
      setCanvasserFocusedGeofenceId(id)
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
        {(role === 'admin' || role === 'canvasser') && (
          <a className="support-link-button" href={supportHref}>
            Support
          </a>
        )}
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
              onClick={() => {
                setGeofenceDeleteConfirmId(null)
                setActiveAdminView('map')
              }}
            >
              Map
            </button>
            <button
              type="button"
              className={activeAdminView === 'dashboard' ? 'view-tab active' : 'view-tab'}
              onClick={() => {
                setGeofenceDeleteConfirmId(null)
                setActiveAdminView('dashboard')
              }}
            >
              Dashboard
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
          </div>
          {assignedGeofenceIdList.length > 1 ? (
            <div className="canvasser-list-area-picker" ref={canvasserListAreaPickerRef}>
              <span id="canvasser-list-area-picker-label" className="canvasser-list-area-picker-label">
                Area
              </span>
              <button
                type="button"
                id="canvasser-list-area-picker-trigger"
                className="canvasser-list-area-picker-trigger"
                aria-labelledby="canvasser-list-area-picker-label"
                aria-haspopup="listbox"
                aria-expanded={canvasserListAreaPickerOpen}
                aria-controls={
                  canvasserListAreaPickerOpen ? 'canvasser-list-area-picker-listbox' : undefined
                }
                onClick={() => setCanvasserListAreaPickerOpen((open) => !open)}
              >
                <span className="canvasser-list-area-picker-value">{canvasserListAreaPickerLabel}</span>
                <span className="canvasser-list-area-picker-chevron" aria-hidden />
              </button>
              {canvasserListAreaPickerOpen ? (
                <ul
                  id="canvasser-list-area-picker-listbox"
                  className="canvasser-list-area-picker-menu"
                  role="listbox"
                  aria-labelledby="canvasser-list-area-picker-label"
                >
                  <li role="none">
                    <button
                      type="button"
                      role="option"
                      className={
                        !canvasserEffectiveFocusGeofenceId
                          ? 'canvasser-list-area-picker-option is-active'
                          : 'canvasser-list-area-picker-option'
                      }
                      aria-selected={!canvasserEffectiveFocusGeofenceId}
                      onClick={() => {
                        setCanvasserFocusedGeofenceId('')
                        setCanvasserListAreaPickerOpen(false)
                      }}
                    >
                      All areas
                    </button>
                  </li>
                  {canvasserProgressByGeofence.map((area) => {
                    const selected = canvasserEffectiveFocusGeofenceId === area.id
                    return (
                      <li key={area.id} role="none">
                        <button
                          type="button"
                          role="option"
                          className={
                            selected
                              ? 'canvasser-list-area-picker-option is-active'
                              : 'canvasser-list-area-picker-option'
                          }
                          aria-selected={selected}
                          onClick={() => {
                            setCanvasserFocusedGeofenceId(area.id)
                            setCanvasserListAreaPickerOpen(false)
                          }}
                        >
                          {area.name}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}
          {canvasserDisplayProgress ? (
            <div
              className="canvasser-list-progress-wrap"
              role="group"
              aria-label={
                canvasserEffectiveFocusGeofenceId
                  ? 'Progress in selected area'
                  : 'Progress in your assigned areas'
              }
            >
              <div className="canvasser-list-progress-card">
                <p className="canvasser-list-progress-scope">
                  {canvasserEffectiveFocusGeofenceId ? (
                    <>
                      <strong>{canvasserDisplayProgress.total}</strong> addresses in this area
                    </>
                  ) : (
                    <>
                      <strong>{canvasserDisplayProgress.total}</strong> addresses across your assigned areas
                    </>
                  )}
                </p>
                <div className="canvasser-list-metric">
                  <div className="canvasser-list-metric-head">
                    <span className="canvasser-list-metric-label" id="canvasser-list-m-canvassed">
                      Canvassed
                    </span>
                    <span className="canvasser-list-metric-pct">{canvasserDisplayProgress.canvassedPercent}%</span>
                  </div>
                  <p className="canvasser-list-metric-caption">
                    {canvasserDisplayProgress.canvassedDone} of {canvasserDisplayProgress.total} addresses
                  </p>
                  <div
                    className="canvasser-list-metric-rail"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={canvasserDisplayProgress.canvassedPercent}
                    aria-labelledby="canvasser-list-m-canvassed"
                    aria-valuetext={`${canvasserDisplayProgress.canvassedDone} of ${canvasserDisplayProgress.total} addresses canvassed`}
                  >
                    <div
                      className="canvasser-list-metric-fill canvasser-list-metric-fill--canvassed"
                      style={{ width: `${canvasserDisplayProgress.canvassedPercent}%` }}
                    />
                  </div>
                </div>
                <div className="canvasser-list-metric canvasser-list-metric--petition">
                  <div className="canvasser-list-metric-head">
                    <span className="canvasser-list-metric-label" id="canvasser-list-m-petition">
                      Signatures
                    </span>
                    <span
                      className="canvasser-list-metric-pct"
                      aria-labelledby="canvasser-list-m-petition"
                    >
                      {canvasserDisplayProgress.petitionDone}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {assignedGeofenceIdList.length === 0 ? (
            <p className="canvasser-list-empty">No areas are assigned to your email yet.</p>
          ) : isCanvasserListLoading ? (
            <p className="canvasser-list-empty">Loading addresses in your areas…</p>
          ) : canvasserListFetchError ? (
            <p className="error-banner">{canvasserListFetchError}</p>
          ) : canvasserListRowsLive.length === 0 ? (
            <p className="canvasser-list-empty">No addresses found inside your assigned areas.</p>
          ) : canvasserRowsForUi.length === 0 ? (
            <div className="canvasser-list-empty-block">
              <p className="canvasser-list-empty">No addresses in this area.</p>
            </div>
          ) : (
            <div className="canvasser-list-body">
              {canvasserStreetGroupsForList.map((group) => {
                const n = group.rows.length
                const c = group.rows.filter((r) => r.canvassed).length
                const p = group.rows.filter((r) => r.signed_petition).length
                return (
                  <CollapsibleStreetBlock
                    key={group.sortKey}
                    blockClassName="canvasser-street-block"
                    defaultOpen={false}
                    summaryClassName="canvasser-street-summary"
                    nameClassName="canvasser-street-name"
                    metaClassName="canvasser-street-count"
                    heading={group.heading}
                    meta={
                      <span className="street-block-stats" aria-label={`${c} of ${n} canvassed, ${p} of ${n} signed`}>
                        <span className="street-block-stat-row">
                          <span className="street-block-stat-label">Canvassed</span>
                          <span className="street-block-stat-value">
                            <strong>{c}</strong>
                            <span className="street-block-stat-slash">/</span>
                            <span className="street-block-stat-den">{n}</span>
                          </span>
                        </span>
                        <span className="street-block-stat-row">
                          <span className="street-block-stat-label">Signed</span>
                          <span className="street-block-stat-value">
                            <strong>{p}</strong>
                            <span className="street-block-stat-slash">/</span>
                            <span className="street-block-stat-den">{n}</span>
                          </span>
                        </span>
                      </span>
                    }
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
                            <span className="canvasser-list-address">{address.full_address}</span>
                            <div className="canvasser-list-row-actions">
                              <button
                                type="button"
                                className="canvasser-list-action"
                                disabled={!canToggle}
                                onClick={() => void toggleCanvassed(address)}
                              >
                                {canToggle
                                  ? address.canvassed
                                    ? 'Mark uncanvassed'
                                    : 'Mark canvassed'
                                  : 'Outside your areas'}
                              </button>
                              <button
                                type="button"
                                className="canvasser-list-action"
                                disabled={!canToggle}
                                onClick={() => void toggleSignedPetition(address)}
                              >
                                {canToggle
                                  ? address.signed_petition
                                    ? 'Clear petition'
                                    : 'Signed petition'
                                  : 'Outside your areas'}
                              </button>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </CollapsibleStreetBlock>
                )
              })}
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
                            You can mark addresses <strong>canvassed</strong> or record a{' '}
                            <strong>signed petition</strong> from address dots, or by using the{' '}
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
                          <li>No areas are assigned to your email yet.</li>
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
              <MapViewportWatcher onViewportChange={onMapViewportChange} />
              <GeofenceDrawManager
                geofences={geofencesForMap}
                enabled={role === 'admin'}
                allowGeofenceSelect={
                  role === 'admin' ||
                  (role === 'canvasser' && assignedGeofenceIdList.length > 1)
                }
                assignedGeofenceIdList={assignedGeofenceIdList}
                selectedGeofenceId={selectedGeofenceId}
                canvasserFocusedGeofenceId={canvasserEffectiveFocusGeofenceId}
                onCreated={handleGeofenceCreated}
                onEdited={handleGeofenceEdited}
                onDeleted={handleGeofenceDeleted}
                onSelect={handleGeofenceMapPick}
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
                    const hasPetition = address.signed_petition
                    const hasCanvassed = address.canvassed
                    const baseRadius = hasPetition || hasCanvassed ? 8 : 7
                    const visualRadius = baseRadius + (isPopupOpen ? 4 : 0)
                    const visualWeight = (hasPetition || hasCanvassed ? 3 : 2) + (isPopupOpen ? 1 : 0)
                    const popupOpenHandlers = {
                      popupopen: () => setAddressPopupOpenId(address.id),
                      popupclose: () =>
                        setAddressPopupOpenId((prev) => (prev === address.id ? null : prev)),
                    }
                    const popupContent = (
                      <>
                        <p className="popup-address">{address.full_address}</p>
                        <div className="popup-address-actions">
                          <button
                            type="button"
                            className="status-button"
                            disabled={!canToggleThisAddress}
                            onClick={() => void toggleCanvassed(address)}
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
                          <button
                            type="button"
                            className="status-button"
                            disabled={!canToggleThisAddress}
                            onClick={() =>
                              void toggleSignedPetition(address, { fromAddressMapPopup: true })
                            }
                          >
                            {role === 'admin'
                              ? address.signed_petition
                                ? 'Clear petition'
                                : 'Signed petition'
                              : canToggleThisAddress
                                ? address.signed_petition
                                  ? 'Clear petition'
                                  : 'Signed petition'
                                : 'Outside your assigned areas'}
                          </button>
                        </div>
                      </>
                    )
                    const visualPathOptions = hasPetition
                      ? {
                          color: '#b45309',
                          fillColor: '#f97316',
                          fillOpacity: 1,
                          weight: visualWeight,
                          className: isPopupOpen
                            ? 'address-dot-visual address-dot-visual--open address-dot-visual--open-petition'
                            : 'address-dot-visual',
                        }
                      : hasCanvassed
                        ? {
                            color: '#ffffff',
                            fillColor: '#2563eb',
                            fillOpacity: 1,
                            weight: visualWeight,
                            className: isPopupOpen
                              ? 'address-dot-visual address-dot-visual--open'
                              : 'address-dot-visual',
                          }
                        : {
                            color: '#7f1d1d',
                            fillColor: '#dc2626',
                            fillOpacity: 1,
                            weight: visualWeight,
                            className: isPopupOpen
                              ? 'address-dot-visual address-dot-visual--open'
                              : 'address-dot-visual',
                          }
                    return (
                      <Fragment key={address.id}>
                        {hasPetition ? (
                          <CircleMarker
                            key={`${address.id}-halo`}
                            center={[address.lat, address.long]}
                            pane="addressPane"
                            radius={isCloseZoom ? 20 : 13}
                            interactive={false}
                            pathOptions={{
                              color: '#d97706',
                              fillColor: '#fbbf24',
                              fillOpacity: 0.26,
                              weight: 2,
                            }}
                          />
                        ) : hasCanvassed ? (
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
                        ) : null}
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
                  const allPetitionSigned =
                    members.length > 0 && members.every((m) => m.signed_petition)
                  const allCanvassed =
                    members.length > 0 && members.every((m) => m.canvassed)
                  const clusterBadgeStyle: ClusterBadgeStyle = allPetitionSigned
                    ? 'petition'
                    : allCanvassed
                      ? 'canvassed'
                      : 'todo'
                  const sortedMembers = [...members].sort((a, b) =>
                    a.full_address.localeCompare(b.full_address),
                  )
                  return (
                    <Fragment key={clusterKey}>
                      {allPetitionSigned ? (
                        <CircleMarker
                          key={`${clusterKey}-halo`}
                          center={[centroidLat, centroidLng]}
                          pane="addressPane"
                          radius={isCloseZoom ? 22 : 15}
                          interactive={false}
                          pathOptions={{
                            color: '#d97706',
                            fillColor: '#fbbf24',
                            fillOpacity: 0.26,
                            weight: 2,
                          }}
                        />
                      ) : allCanvassed ? (
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
                      ) : null}
                      <Marker
                        position={[centroidLat, centroidLng]}
                        pane="addressPane"
                        icon={createClusterCountIcon(
                          members.length,
                          clusterBadgeStyle,
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
                onToggleCanvassed={toggleCanvassed}
                onToggleSignedPetition={toggleSignedPetition}
              />
            )}
          </section>
          {role === 'canvasser' && (
            <aside
              ref={canvasserAreasPanelRef}
              className={`geofence-panel canvasser-areas-panel${
                canvasserAreasPanelExpanded ? ' canvasser-areas-panel--expanded' : ''
              }`}
              aria-label="Your assigned areas"
            >
              <div id="canvasser-areas-expandable" className="canvasser-areas-expandable">
                <div className="geofence-panel-header canvasser-areas-panel-title-row">
                  <h3>{canvasserAreasTitle}</h3>
                  <button
                    type="button"
                    className="canvasser-drawer-close"
                    aria-label="Close assigned areas panel"
                    onClick={() => setCanvasserAreasPanelExpanded(false)}
                  >
                    ×
                  </button>
                </div>
                {assignedGeofenceIdList.length === 0 ? (
                  <p className="geofence-panel-lead">
                    No areas are assigned to your email yet. Ask an admin to assign an area.
                  </p>
                ) : isCanvasserListLoading ? (
                  <p className="geofence-panel-lead">Loading addresses in your areas…</p>
                ) : canvasserListFetchError ? (
                  <p className="error-banner">{canvasserListFetchError}</p>
                ) : canvasserDisplayProgress ? (
                  <>
                    {assignedGeofenceIdList.length > 1 ? (
                      <h4 className="canvasser-panel-section-title">Overall</h4>
                    ) : null}
                    <div className="geofence-progress">
                      {assignedGeofenceIdList.length > 1 &&
                      canvasserEffectiveFocusGeofenceId ? (
                        <button
                          type="button"
                          className="progress-summary canvasser-progress-summary--tap-all"
                          onClick={() => setCanvasserFocusedGeofenceId('')}
                          aria-label={`${canvasserDrawerOverallProgress.canvassedDone} of ${canvasserDrawerOverallProgress.total} addresses canvassed (${canvasserDrawerOverallProgress.canvassedPercent} percent). ${canvasserDrawerOverallProgress.petitionDone} petitions signed. Tap to show all areas on the map.`}
                        >
                          <div className="progress-headline">
                            <span className="progress-headline-label">Canvassed</span>
                            <strong>{canvasserDrawerOverallProgress.canvassedPercent}%</strong>
                          </div>
                          <p className="progress-subline">
                            {canvasserDrawerOverallProgress.canvassedDone} of{' '}
                            {canvasserDrawerOverallProgress.total} addresses
                          </p>
                          <div className="progress-bar-track" aria-hidden="true">
                            <div
                              className="progress-bar-fill canvasser-areas-progress-fill"
                              style={{ width: `${canvasserDrawerOverallProgress.canvassedPercent}%` }}
                            />
                          </div>
                          <div className="progress-headline canvasser-progress-headline--secondary">
                            <span className="progress-headline-label">Signatures</span>
                            <strong>{canvasserDrawerOverallProgress.petitionDone}</strong>
                          </div>
                        </button>
                      ) : (
                        <div className="progress-summary">
                          <div className="progress-headline">
                            <span className="progress-headline-label">Canvassed</span>
                            <strong>{canvasserDrawerOverallProgress.canvassedPercent}%</strong>
                          </div>
                          <p className="progress-subline">
                            {canvasserDrawerOverallProgress.canvassedDone} of{' '}
                            {canvasserDrawerOverallProgress.total} addresses
                          </p>
                          <div
                            className="progress-bar-track"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={canvasserDrawerOverallProgress.canvassedPercent}
                            aria-valuetext={`${canvasserDrawerOverallProgress.canvassedDone} of ${canvasserDrawerOverallProgress.total} addresses canvassed`}
                          >
                            <div
                              className="progress-bar-fill canvasser-areas-progress-fill"
                              style={{ width: `${canvasserDrawerOverallProgress.canvassedPercent}%` }}
                            />
                          </div>
                          <div className="progress-headline canvasser-progress-headline--secondary">
                            <span className="progress-headline-label">Petitions signed</span>
                            <strong>{canvasserDrawerOverallProgress.petitionDone}</strong>
                          </div>
                        </div>
                      )}
                    </div>
                    {assignedGeofenceIdList.length > 1 ? (
                      <div className="canvasser-area-breakdown">
                        <h4 className="canvasser-panel-section-title canvasser-panel-section-title--by-area">
                          By area
                        </h4>
                        <ul className="canvasser-area-breakdown-list">
                          {canvasserProgressByGeofence.map((area) => {
                            const mapFocused = canvasserEffectiveFocusGeofenceId === area.id
                            return (
                              <li key={area.id} className="canvasser-area-breakdown-item">
                                <details
                                  className={`canvasser-area-details${mapFocused ? ' canvasser-area-details--map-focus' : ''}`}
                                >
                                  <summary className="canvasser-area-summary">
                                    <span className="canvasser-area-summary-name">{area.name}</span>
                                    <span className="canvasser-area-summary-stats">
                                      <span className="canvasser-area-summary-pair">
                                        <span className="canvasser-area-summary-pair-label">Canvassed</span>
                                        <span className="canvasser-area-summary-pair-val">
                                          {area.canvassedDone}/{area.total}
                                        </span>
                                      </span>
                                      <span className="canvasser-area-summary-pair">
                                        <span className="canvasser-area-summary-pair-label">Petitions</span>
                                        <span className="canvasser-area-summary-pair-val">
                                          {area.petitionDone}
                                        </span>
                                      </span>
                                    </span>
                                    <span className="canvasser-area-summary-chevron" aria-hidden="true" />
                                  </summary>
                                  <div className="canvasser-area-details-body">
                                    {area.total > 0 ? (
                                      <>
                                        <div className="canvasser-area-breakdown-metric">
                                          <div className="progress-headline">
                                            <span className="progress-headline-label">Canvassed</span>
                                            <strong>{area.canvassedPercent}%</strong>
                                          </div>
                                          <p className="progress-subline">
                                            {area.canvassedDone} of {area.total} addresses
                                          </p>
                                          <div
                                            className="progress-bar-track canvasser-area-breakdown-bar"
                                            role="progressbar"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={area.canvassedPercent}
                                            aria-valuetext={`${area.name}: ${area.canvassedDone} of ${area.total} canvassed`}
                                          >
                                            <div
                                              className="progress-bar-fill canvasser-areas-progress-fill"
                                              style={{ width: `${area.canvassedPercent}%` }}
                                            />
                                          </div>
                                        </div>
                                        <div className="canvasser-area-breakdown-metric canvasser-area-breakdown-metric--petition-count">
                                          <div className="progress-headline canvasser-progress-headline--secondary">
                                            <span className="progress-headline-label">Petitions signed</span>
                                            <strong>{area.petitionDone}</strong>
                                          </div>
                                        </div>
                                        <button
                                          type="button"
                                          className="canvasser-area-map-focus-btn"
                                          disabled={mapFocused}
                                          aria-pressed={mapFocused}
                                          onClick={() => setCanvasserFocusedGeofenceId(area.id)}
                                        >
                                          Show on map
                                        </button>
                                      </>
                                    ) : (
                                      <p className="canvasser-area-breakdown-empty">
                                        No addresses in this area
                                      </p>
                                    )}
                                  </div>
                                </details>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="geofence-panel-lead">No addresses found inside your assigned areas.</p>
                )}
              </div>
              <button
                type="button"
                className="canvasser-areas-mobile-strip"
                aria-expanded={canvasserAreasPanelExpanded}
                aria-controls="canvasser-areas-expandable"
                onClick={() => setCanvasserAreasPanelExpanded((open) => !open)}
                aria-label={
                  canvasserAreasPanelExpanded
                    ? 'Hide assigned areas details'
                    : 'Show assigned areas and progress by area'
                }
              >
                {assignedGeofenceIdList.length === 0 ? (
                  <div className="canvasser-areas-strip-row">
                    <span className="canvasser-areas-strip-title">Your areas</span>
                    <span className="canvasser-areas-strip-meta">None assigned</span>
                    <span className="canvasser-areas-strip-chevron" aria-hidden="true">
                      {canvasserAreasPanelExpanded ? '▲' : '▼'}
                    </span>
                  </div>
                ) : isCanvasserListLoading ? (
                  <div className="canvasser-areas-strip-row">
                    <span className="canvasser-areas-strip-title">
                      Your areas ({assignedGeofenceIdList.length})
                    </span>
                    <span className="canvasser-areas-strip-meta">Loading…</span>
                    <span className="canvasser-areas-strip-chevron" aria-hidden="true">
                      {canvasserAreasPanelExpanded ? '▲' : '▼'}
                    </span>
                  </div>
                ) : canvasserListFetchError ? (
                  <div className="canvasser-areas-strip-row">
                    <span className="canvasser-areas-strip-title">
                      Your areas ({assignedGeofenceIdList.length})
                    </span>
                    <span className="canvasser-areas-strip-meta">Could not load</span>
                    <span className="canvasser-areas-strip-chevron" aria-hidden="true">
                      {canvasserAreasPanelExpanded ? '▲' : '▼'}
                    </span>
                  </div>
                ) : canvasserListProgress !== null ? (
                  <>
                    <div className="canvasser-areas-strip-row">
                      <span className="canvasser-areas-strip-title">
                        Your areas ({assignedGeofenceIdList.length})
                      </span>
                      <span className="canvasser-areas-strip-meta canvasser-areas-strip-meta--stacked">
                        <span className="canvasser-areas-strip-meta-line">
                          {canvasserDrawerOverallProgress.canvassedDone} of{' '}
                          {canvasserDrawerOverallProgress.total} canvassed (
                          {canvasserDrawerOverallProgress.canvassedPercent}%)
                        </span>
                        <span className="canvasser-areas-strip-meta-line">
                          {canvasserDrawerOverallProgress.petitionDone} petitions signed
                        </span>
                      </span>
                      <span className="canvasser-areas-strip-chevron" aria-hidden="true">
                        {canvasserAreasPanelExpanded ? '▲' : '▼'}
                      </span>
                    </div>
                    <div className="canvasser-areas-strip-bars" aria-hidden="true">
                      <div className="canvasser-areas-strip-bar">
                        <div
                          className="canvasser-areas-strip-bar-fill"
                          style={{ width: `${canvasserDrawerOverallProgress.canvassedPercent}%` }}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="canvasser-areas-strip-row">
                    <span className="canvasser-areas-strip-title">
                      Your areas ({assignedGeofenceIdList.length})
                    </span>
                    <span className="canvasser-areas-strip-meta">No addresses</span>
                    <span className="canvasser-areas-strip-chevron" aria-hidden="true">
                      {canvasserAreasPanelExpanded ? '▲' : '▼'}
                    </span>
                  </div>
                )}
              </button>
            </aside>
          )}
          {role === 'admin' && (
            <aside
              className={`geofence-panel admin-geofence-panel${
                adminGeofencePanelExpanded ? ' admin-geofence-panel--expanded' : ''
              }${selectedGeofence ? ' admin-geofence-panel--detail-open' : ''}`}
            >
              <button
                type="button"
                className="admin-geofence-mobile-strip"
                aria-expanded={adminGeofencePanelExpanded}
                aria-controls="admin-geofence-expandable"
                onClick={() => setAdminGeofencePanelExpanded((open) => !open)}
                aria-label={
                  adminGeofencePanelExpanded
                    ? 'Hide area details panel'
                    : 'Show area details panel'
                }
              >
                <div className="admin-geofence-mobile-strip-row">
                  {adminGeofencePanelExpanded && selectedGeofence ? (
                    <span
                      className="admin-geofence-mobile-strip-title admin-geofence-mobile-strip-title--spacer"
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="admin-geofence-mobile-strip-title">{geofenceDetailsTitle}</span>
                  )}
                  <span className="admin-geofence-mobile-strip-chevron" aria-hidden="true">
                    {adminGeofencePanelExpanded ? '▲' : '▼'}
                  </span>
                </div>
              </button>
              <div id="admin-geofence-expandable" className="admin-geofence-expandable">
                {!selectedGeofence ? (
                  <div className="admin-geofence-viewer-filter">
                    <label className="admin-geofence-viewer-filter-label" htmlFor="admin-area-viewer-email-filter">
                      Show areas for
                    </label>
                    <select
                      id="admin-area-viewer-email-filter"
                      className="admin-geofence-viewer-filter-select"
                      value={adminAreaViewerEmailFilter}
                      onChange={(event) => setAdminAreaViewerEmailFilter(event.target.value)}
                    >
                      <option value="">All users</option>
                      {adminAreaViewerAssigneeSelectOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {selectedGeofence ? (
                  <div className="admin-geofence-detail-header-stack">
                    <div className="admin-geofence-detail-back-row">
                      <button
                        type="button"
                        className="admin-geofence-back-to-all-btn"
                        aria-label="Back to all areas"
                        onClick={() => selectGeofenceId('')}
                      >
                        <GeofenceChevronLeftIcon />
                        <span>All areas</span>
                      </button>
                    </div>
                    <div className="geofence-panel-header admin-geofence-detail-title-row">
                      {isEditingGeofenceTitle ? (
                        <input
                          ref={geofenceTitleInputRef}
                          id="admin-geofence-detail-title"
                          className="admin-geofence-detail-title-input"
                          type="text"
                          aria-label="Area name"
                          value={geofenceNameDraft}
                          onChange={(event) => setGeofenceNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void commitGeofenceTitleEdit({ silent: false })
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelGeofenceTitleEdit()
                            }
                          }}
                          onBlur={() => {
                            void commitGeofenceTitleEdit({ silent: true })
                          }}
                        />
                      ) : (
                        <h3
                          id="admin-geofence-detail-title"
                          className="admin-geofence-detail-area-title admin-geofence-detail-area-title--with-edit"
                        >
                          <button
                            type="button"
                            className="admin-geofence-detail-title-text-btn"
                            onClick={startGeofenceTitleEdit}
                          >
                            {geofenceDetailsTitle}
                          </button>
                          <button
                            type="button"
                            className="admin-geofence-detail-title-icon-btn"
                            aria-label="Edit area name"
                            onClick={startGeofenceTitleEdit}
                          >
                            <GeofencePencilIcon />
                          </button>
                        </h3>
                      )}
                      <div className="geofence-panel-menu-anchor" ref={geofencePanelMenuRef}>
                        <button
                          type="button"
                          className="geofence-panel-menu-trigger"
                          aria-label="Area actions"
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
                            aria-label="Area actions"
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
                              className="geofence-panel-menu-item"
                              role="menuitem"
                              disabled={
                                isGeofenceProgressLoading ||
                                !geofenceProgress ||
                                geofenceProgress.petitionRemaining <= 0
                              }
                              onClick={() => {
                                setGeofencePanelMenuOpen(false)
                                setMarkAllTargetSigned(true)
                                setMarkAllPetitionDialogOpen(true)
                              }}
                            >
                              <GeofenceMarkCanvassedIcon />
                              <span>Mark all signed petition</span>
                            </button>
                            <button
                              type="button"
                              className="geofence-panel-menu-item"
                              role="menuitem"
                              disabled={
                                isGeofenceProgressLoading ||
                                !geofenceProgress ||
                                geofenceProgress.petitionSigned <= 0
                              }
                              onClick={() => {
                                setGeofencePanelMenuOpen(false)
                                setMarkAllTargetSigned(false)
                                setMarkAllPetitionDialogOpen(true)
                              }}
                            >
                              <GeofenceMarkCanvassedIcon />
                              <span>Mark all unsigned petition</span>
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
                              <span>Delete area</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="geofence-panel-header">
                    <h3>{geofenceDetailsTitle}</h3>
                  </div>
                )}
                {selectedGeofence ? (
                  <>
                  <div className="geofence-progress geofence-progress--inline">
                    {isGeofenceProgressLoading ? (
                      <p>Loading progress...</p>
                    ) : geofenceProgress ? (
                      <div className="admin-geofence-dual-progress">
                        <section
                          className="admin-geofence-metric"
                          aria-labelledby="admin-geofence-metric-canvassed-title"
                        >
                          <div className="admin-geofence-metric__header">
                            <h4 className="admin-geofence-metric__title" id="admin-geofence-metric-canvassed-title">
                              Canvassed
                            </h4>
                            <span className="admin-geofence-metric__percent">
                              {geofenceCompletionPercent}%
                            </span>
                          </div>
                          <div className="admin-geofence-metric__track" aria-hidden="true">
                            <div
                              className="admin-geofence-metric__fill admin-geofence-metric__fill--canvassed"
                              style={{
                                width: `${Math.min(100, Math.max(0, geofenceCompletionPercent))}%`,
                              }}
                            />
                          </div>
                          <p className="admin-geofence-metric__caption">
                            {geofenceProgress.canvassed} of {geofenceProgress.total} addresses
                          </p>
                        </section>
                        <section
                          className="admin-geofence-metric admin-geofence-metric--petition"
                          aria-labelledby="admin-geofence-metric-petition-title"
                        >
                          <div className="admin-geofence-metric__header">
                            <h4 className="admin-geofence-metric__title" id="admin-geofence-metric-petition-title">
                              Signatures
                            </h4>
                            <span
                              className="admin-geofence-metric__numeric"
                              aria-label={`${geofenceProgress.petitionSigned} petitions signed`}
                            >
                              {geofenceProgress.petitionSigned}
                            </span>
                          </div>
                        </section>
                      </div>
                    ) : (
                      <p>Select an area to see progress.</p>
                    )}
                  </div>
                  <label>
                    Assigned canvasser
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
                          aria-label="Assign area email"
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
                      Save area
                    </button>
                  </div>
                  </>
                ) : geofences.length === 0 ? (
                  <p>Draw or click an area to edit assignment and view progress.</p>
                ) : adminGeofencesFiltered.length === 0 ? (
                  <p className="geofence-panel-lead">
                    No areas are assigned to this person. Switch the dropdown back to All users or pick another
                    assignee.
                  </p>
                ) : (
                  <div className="admin-geofence-overview">
                    {isAdminGeofenceOverviewLoading ? (
                      <p className="admin-geofence-overview-status">Loading areas…</p>
                    ) : adminGeofenceOverviewError ? (
                      <p className="access-message">{adminGeofenceOverviewError}</p>
                    ) : (
                      <ul className="admin-geofence-overview-list" role="list">
                        {adminGeofenceOverviewDisplay.map((row) => (
                          <li key={row.id}>
                            <button
                              type="button"
                              className="admin-geofence-overview-row"
                              onClick={() => selectGeofenceId(row.id, { focusOnMap: true })}
                            >
                              <div className="admin-geofence-overview-row-head">
                                <span className="admin-geofence-overview-row-name">{row.name}</span>
                              </div>
                              <div className="admin-geofence-overview-metrics">
                                <div className="admin-geofence-overview-metric">
                                  <div className="admin-geofence-overview-metric__top">
                                    <span className="admin-geofence-overview-metric__label">
                                      Canvassed
                                    </span>
                                    <span className="admin-geofence-overview-metric__stat">
                                      {row.canvassed} of {row.total} ({row.pct}%)
                                    </span>
                                  </div>
                                  <div className="admin-geofence-overview-metric__track" aria-hidden="true">
                                    <div
                                      className="admin-geofence-overview-metric__fill admin-geofence-overview-metric__fill--canvassed"
                                      style={{
                                        width: `${Math.min(100, Math.max(0, Number(row.pct) || 0))}%`,
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
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
                    <h4 id="geofence-delete-dialog-title">Delete this area?</h4>
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
              {markAllPetitionDialogOpen && selectedGeofence && (
                <div
                  className="geofence-confirm-backdrop"
                  role="presentation"
                  onClick={(event) => {
                    if (event.target === event.currentTarget && !isMarkingAllPetition) {
                      setMarkAllPetitionDialogOpen(false)
                    }
                  }}
                >
                  <div
                    className="geofence-confirm-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="geofence-mark-all-petition-dialog-title"
                  >
                    <h4 id="geofence-mark-all-petition-dialog-title">
                      Mark all addresses {markAllTargetSigned ? 'signed petition' : 'unsigned petition'}?
                    </h4>
                    <p>
                      Every address inside{' '}
                      <span className="geofence-confirm-name">{geofenceDisplayNameForDelete}</span>{' '}
                      will have petition signature set to {markAllTargetSigned ? 'signed' : 'not signed'}.
                      Canvassed status is unchanged. You can still adjust individual addresses later.
                    </p>
                    <div className="geofence-confirm-actions">
                      <button
                        type="button"
                        className="geofence-confirm-cancel"
                        disabled={isMarkingAllPetition}
                        onClick={() => setMarkAllPetitionDialogOpen(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="geofence-confirm-apply"
                        disabled={isMarkingAllPetition}
                        onClick={() => void confirmMarkAllPetitionInGeofence()}
                      >
                        {isMarkingAllPetition
                          ? 'Updating…'
                          : markAllTargetSigned
                            ? 'Mark all signed'
                            : 'Mark all unsigned'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </aside>
          )}
        </section>
      ) : null}
      {role === 'admin' && activeAdminView === 'dashboard' && (
        <section className="admin-panel admin-dashboard" aria-label="Canvassing effort dashboard">
          <div className="admin-panel-header">
            <div>
              <h2>Dashboard</h2>
            </div>
          </div>
          {adminDashboardError ? <p className="error-banner">{adminDashboardError}</p> : null}
          {adminDashboardLoading ? (
            <p className="access-message">Loading dashboard…</p>
          ) : adminDashboardEffort ? (
            <>
              <div className="admin-dashboard-metrics">
                <div className="admin-dashboard-metric-card">
                  <h3 className="admin-dashboard-metric-title">Canvassed</h3>
                  <p className="admin-dashboard-metric-value">
                    <strong>{adminDashboardEffort.canvassed_count}</strong>
                    <span className="admin-dashboard-metric-sep"> / </span>
                    {adminDashboardEffort.total_addresses_in_areas}
                  </p>
                  <p className="admin-dashboard-metric-sub">
                    {adminDashboardEffort.total_addresses_in_areas === 0
                      ? '—'
                      : `${Math.round(
                          (adminDashboardEffort.canvassed_count /
                            adminDashboardEffort.total_addresses_in_areas) *
                            100,
                        )}%`}
                  </p>
                </div>
                <div className="admin-dashboard-metric-card admin-dashboard-metric-card--petition">
                  <h3 className="admin-dashboard-metric-title">Petitions signed</h3>
                  <p className="admin-dashboard-metric-value">
                    <strong>{adminDashboardEffort.petition_signed_count}</strong>
                  </p>
                </div>
              </div>
              <div className="admin-dashboard-leaderboard-head">
                <h3 className="admin-dashboard-leaderboard-title" id="admin-dashboard-leaderboard-heading">
                  Leaderboard
                </h3>
                <div className="admin-dashboard-range" role="group" aria-label="Time range for leaderboard">
                  <button
                    type="button"
                    className={
                      adminDashboardLeaderboardRange === 'all' ? 'view-tab active' : 'view-tab'
                    }
                    onClick={() => setAdminDashboardLeaderboardRange('all')}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={
                      adminDashboardLeaderboardRange === '30d' ? 'view-tab active' : 'view-tab'
                    }
                    onClick={() => setAdminDashboardLeaderboardRange('30d')}
                  >
                    30 days
                  </button>
                </div>
              </div>
              <div className="profiles-table-wrap">
                <table
                  className="profiles-table admin-dashboard-leaderboard-table"
                  aria-label="Contributor credits by person"
                >
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Role</th>
                      <th scope="col">Canvassed</th>
                      <th scope="col">Signatures</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminDashboardLeaderboard.length === 0 ? (
                      <tr>
                        <td colSpan={4}>No activity recorded yet for this range.</td>
                      </tr>
                    ) : (
                      adminDashboardLeaderboard.map((row) => (
                        <tr key={row.actor_id}>
                          <td data-label="Email">{row.actor_email || row.actor_id}</td>
                          <td data-label="Role">{row.actor_role}</td>
                          <td data-label="Canvassed">{row.canvassed_marks}</td>
                          <td data-label="Signatures">{row.petition_marks}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="access-message">No summary data.</p>
          )}
        </section>
      )}
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
