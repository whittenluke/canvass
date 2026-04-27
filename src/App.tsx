import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
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
  first_name: string | null
  last_name: string | null
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

function addressInAssignedGeofences(
  address: AddressRow,
  geofences: GeofenceRow[],
  assignedGeofenceIdSet: Set<string>,
): boolean {
  return geofences.some(
    (g) =>
      assignedGeofenceIdSet.has(g.id) &&
      booleanPointInPolygon(point([address.long, address.lat]), g.geometry),
  )
}

function splitFullName(fullName: string): { firstName: string | null; lastName: string | null } {
  const trimmed = fullName.trim()
  if (!trimmed) return { firstName: null, lastName: null }
  const parts = trimmed.split(/\s+/)
  const firstName = parts[0] ?? null
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null
  return { firstName, lastName }
}

function accessDisplayName(entry: AccessRow): string {
  const first = entry.first_name?.trim() ?? ''
  const last = entry.last_name?.trim() ?? ''
  const full = `${first} ${last}`.trim()
  return full || entry.email
}

type SupabaseClientNonNull = NonNullable<typeof supabase>
type AdminMarkGeofenceResultRow = {
  updated_count: number
  already_canvassed: number
  total_count: number
}
type AdminGeofenceProgressRow = {
  total_count: number
  canvassed_count: number
  remaining_count: number
}

async function fetchAddressStatsInsidePolygon(
  client: SupabaseClientNonNull,
  polygon: GeoJSON.Polygon,
): Promise<GeofenceProgress> {
  const coords = polygon.coordinates[0] ?? []
  if (coords.length === 0) {
    return { total: 0, canvassed: 0, remaining: 0 }
  }
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
    const { data, error } = await client
      .from('addresses')
      .select('lat,long,canvassed')
      .gte('lat', minLat)
      .lte('lat', maxLat)
      .gte('long', minLng)
      .lte('long', maxLng)
      .range(from, from + pageSize - 1)
    if (error) {
      throw new Error(error.message)
    }
    const rows = (data as Array<{ lat: number; long: number; canvassed: boolean }>) ?? []
    rows.forEach((row) => {
      if (booleanPointInPolygon(point([row.long, row.lat]), polygon)) {
        total += 1
        if (row.canvassed) canvassed += 1
      }
    })
    if (rows.length < pageSize) done = true
    else from += pageSize
  }
  return { total, canvassed, remaining: Math.max(total - canvassed, 0) }
}

/** First line of address with leading house number stripped, for grouping and headers. */
function streetHeadingFromFullAddress(fullAddress: string): string {
  const firstLine = fullAddress.split(',')[0]?.trim() ?? fullAddress.trim()
  const stripped = firstLine.replace(/^(\d+[A-Za-z]?(?:\s*-\s*\d+[A-Za-z]?)?)\s+/, '').trim()
  return stripped || firstLine
}

type StreetAddressGroup = {
  sortKey: string
  heading: string
  rows: AddressRow[]
}

function CollapsibleStreetBlock({
  blockClassName,
  defaultOpen,
  summaryClassName,
  nameClassName,
  metaClassName,
  heading,
  meta,
  children,
}: {
  blockClassName: string
  defaultOpen: boolean
  summaryClassName: string
  nameClassName: string
  metaClassName: string
  heading: string
  meta: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={blockClassName}>
      <button
        type="button"
        className={summaryClassName}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="collapsible-street-heading-group">
          <span className={nameClassName}>{heading}</span>
          <span className="collapsible-street-chevron" aria-hidden="true">
            {open ? '▲' : '▼'}
          </span>
        </span>
        <span className={metaClassName}>{meta}</span>
      </button>
      {open ? <div className="collapsible-street-panel">{children}</div> : null}
    </div>
  )
}

function buildStreetGroups(addresses: AddressRow[]): StreetAddressGroup[] {
  const bucket = new Map<string, { heading: string; rows: AddressRow[]; seen: Set<string> }>()
  for (const row of addresses) {
    const heading = streetHeadingFromFullAddress(row.full_address)
    const sortKey = heading.toLowerCase()
    let g = bucket.get(sortKey)
    if (!g) {
      g = { heading, rows: [], seen: new Set() }
      bucket.set(sortKey, g)
    }
    if (g.seen.has(row.id)) {
      continue
    }
    g.seen.add(row.id)
    g.rows.push(row)
  }
  const groups: StreetAddressGroup[] = [...bucket.entries()].map(([sortKey, g]) => ({
    sortKey,
    heading: g.heading,
    rows: g.rows,
  }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  for (const g of groups) {
    g.rows.sort((x, y) =>
      x.full_address.localeCompare(y.full_address, undefined, { numeric: true }),
    )
  }
  return groups
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const x =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

function clusterAddressesByProximity(addresses: AddressRow[], maxDistanceM: number): AddressRow[][] {
  const n = addresses.length
  if (n === 0) return []
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i])
    return parent[i]
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        haversineMeters(addresses[i].lat, addresses[i].long, addresses[j].lat, addresses[j].long) <=
        maxDistanceM
      ) {
        union(i, j)
      }
    }
  }
  const buckets = new Map<number, AddressRow[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!buckets.has(r)) buckets.set(r, [])
    buckets.get(r)!.push(addresses[i])
  }
  return [...buckets.values()]
}

/** Min distance (m) between any point in A and any point in B. */
function crossClusterMinMeters(a: AddressRow[], b: AddressRow[]): number {
  let min = Infinity
  for (const pa of a) {
    for (const pb of b) {
      const d = haversineMeters(pa.lat, pa.long, pb.lat, pb.long)
      if (d < min) min = d
    }
  }
  return min
}

/**
 * Merge cluster pairs whose closest points are within maxGapM.
 * Catches one building split into two graph components when the first pass threshold
 * is shorter than the gap between wings (first pass only unions pairwise ≤ N m).
 */
function mergeClustersByCrossGap(clusters: AddressRow[][], maxGapM: number): AddressRow[][] {
  const list = clusters.map((c) => [...c])
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const minD = crossClusterMinMeters(list[i], list[j])
        if (
          minD <= maxGapM &&
          (list[i].length >= 2 || list[j].length >= 2)
        ) {
          list[i] = [...list[i], ...list[j]]
          list.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return list
}

const METERS_PER_DEGREE_LAT = 111_111

/**
 * O(n) viewport grid: bucket addresses by lat/lng cells sized in ~screen pixels at the current zoom.
 * Used for admin overview so dots can appear earlier without O(n²) proximity clustering on thousands of points.
 */
function clusterAddressesByViewportGrid(
  addresses: AddressRow[],
  viewport: ViewportBounds,
  cellPixels: number,
): AddressRow[][] {
  const centerLat = Math.min(85, Math.max(-85, (viewport.south + viewport.north) / 2))
  const cosLat = Math.max(0.12, Math.cos((centerLat * Math.PI) / 180))
  const metersPerPixel = (156543.03392804097 * cosLat) / Math.pow(2, viewport.zoom)
  const cellMeters = cellPixels * metersPerPixel
  const dLat = cellMeters / METERS_PER_DEGREE_LAT
  const dLng = cellMeters / (METERS_PER_DEGREE_LAT * cosLat)

  const buckets = new Map<string, AddressRow[]>()
  for (const a of addresses) {
    const gi = Math.floor(a.lat / dLat)
    const gj = Math.floor(a.long / dLng)
    const key = `${gi},${gj}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(a)
  }
  return [...buckets.values()]
}

function sortClustersSinglesFirst(clusters: AddressRow[][]): AddressRow[][] {
  const singles = clusters.filter((c) => c.length === 1)
  const multi = clusters.filter((c) => c.length > 1)
  return [...singles, ...multi]
}

/** New icon per marker: Leaflet must not reuse one DivIcon instance across multiple markers. */
function createClusterCountIcon(count: number, allCanvassed: boolean): L.DivIcon {
  const badgeClass = allCanvassed
    ? 'address-cluster-hit__badge address-cluster-hit__badge--all-canvassed'
    : 'address-cluster-hit__badge'
  return L.divIcon({
    className: 'address-cluster-leaflet-marker',
    html: `<div class="address-cluster-hit" aria-hidden="true"><span class="${badgeClass}">${count}</span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  })
}

const RURAL_HALL_CENTER: [number, number] = [36.2413, -80.2937]
const APP_ROLES = new Set(['admin', 'canvasser'])
/** Max addresses loaded for the map viewport (clustering cost grows quickly above ~4–6k at admin detail zoom). */
const VIEWPORT_LIMIT = 6000
/** Canvassers need dots a bit earlier while walking. */
const DOTS_VISIBLE_MIN_ZOOM_CANVASSER = 15
/** Admin: dots from this zoom; overview uses grid clustering (see ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM). */
const DOTS_VISIBLE_MIN_ZOOM_ADMIN = 15
/** Admin: at this zoom and above, use tight proximity clusters (buildings); below, use grid overview clusters. */
const ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM = 17
/** Canvasser: invisible CircleMarker radius (px), much larger than the visible dot for finger taps. */
const CANVASSER_ADDRESS_HIT_RADIUS_PX = 26
/** First pass: union pairs within this distance (m). */
const ADDRESS_CLUSTER_MERGE_METERS = 12
/** Second pass: merge whole clusters if any cross-cluster pair is within this (m). Catches wide footprints. */
const ADDRESS_CLUSTER_CROSS_GAP_METERS = 22
const APPROVED_LOGIN_EMAILS = (import.meta.env.VITE_ALLOWED_LOGIN_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean)
const RESET_PASSWORD_QUERY_KEY = 'reset_password'
const AUTH_REDIRECT_OVERRIDE = import.meta.env.VITE_AUTH_REDIRECT_URL?.trim()

function hasResetPasswordIntentInUrl(): boolean {
  if (typeof window === 'undefined') return false
  const url = new URL(window.location.href)
  if (url.searchParams.get(RESET_PASSWORD_QUERY_KEY) === '1') return true
  if (url.hash.startsWith('#')) {
    const hashParams = new URLSearchParams(url.hash.slice(1))
    if (hashParams.get(RESET_PASSWORD_QUERY_KEY) === '1') return true
    if (hashParams.get('type') === 'recovery') return true
    if (hashParams.has('access_token') && hashParams.has('refresh_token')) return true
  }
  return window.location.href.includes('type=recovery')
}

function getAuthRedirectUrl(pathAndQuery: string): string {
  if (AUTH_REDIRECT_OVERRIDE) {
    const base = AUTH_REDIRECT_OVERRIDE.endsWith('/')
      ? AUTH_REDIRECT_OVERRIDE.slice(0, -1)
      : AUTH_REDIRECT_OVERRIDE
    const suffix = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`
    return `${base}${suffix}`
  }
  const host = window.location.hostname
  const isLocal = host === 'localhost' || host === '127.0.0.1'
  if (isLocal) {
    return `http://localhost:8888${pathAndQuery}`
  }
  return `${window.location.origin}${pathAndQuery}`
}

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

function MapStatusLine({
  dotsEnabled,
  showAddressDots,
  hitViewportLimit,
  role,
}: {
  dotsEnabled: boolean
  showAddressDots: boolean
  hitViewportLimit: boolean
  role: string
}) {
  let text: string
  let muted = false
  if (!dotsEnabled) {
    text = 'Address dots are hidden. Use "Show dots" to re-enable.'
  } else if (!showAddressDots) {
    text =
      role === 'admin'
        ? 'Zoom in closer to show address dots'
        : 'Zoom in to see address dots.'
  } else if (hitViewportLimit) {
    text = `Too many points in this view; showing first ${VIEWPORT_LIMIT}. Zoom in for full detail.`
  } else {
    text = 'Map ready.'
    muted = true
  }

  return (
    <div className="map-status-line map-status-line--inline" role="status" aria-live="polite">
      <span className={muted ? 'map-status-text muted' : 'map-status-text'}>{text}</span>
    </div>
  )
}

function GeofenceDrawManager({
  geofences,
  enabled,
  allowGeofenceSelect,
  assignedGeofenceIdList,
  selectedGeofenceId,
  onCreated,
  onEdited,
  onDeleted,
  onSelect,
}: {
  geofences: GeofenceRow[]
  enabled: boolean
  allowGeofenceSelect: boolean
  assignedGeofenceIdList: string[]
  selectedGeofenceId: string
  onCreated: (geometry: GeoJSON.Polygon) => void
  onEdited: (updates: Array<{ id: string; geometry: GeoJSON.Polygon }>) => void
  onDeleted: (ids: string[]) => void | Promise<boolean>
  onSelect: (id: string) => void
}) {
  const map = useMap()
  const featureGroupRef = useRef<L.FeatureGroup | null>(null)
  const drawControlRef = useRef<L.Control.Draw | null>(null)
  /** While drawing/editing/deleting geofences, ignore map background clicks so we do not clear selection. */
  const blockGeofenceClearOnMapClickRef = useRef(false)

  useEffect(() => {
    if (!featureGroupRef.current) {
      featureGroupRef.current = new L.FeatureGroup()
      map.addLayer(featureGroupRef.current)
    }

    const group = featureGroupRef.current
    group.clearLayers()
    const assignedSet = new Set(assignedGeofenceIdList)
    geofences.forEach((fence) => {
      const isMine = assignedSet.has(fence.id)
      let color: string
      let weight: number
      let fillColor: string
      let fillOpacity: number
      if (allowGeofenceSelect) {
        /* Darker violet for contrast on OSM; fill still translucent so roads show through. */
        color = '#4c1d95'
        weight = 3
        fillColor = '#c4b5fd'
        fillOpacity = 0.34
      } else if (assignedGeofenceIdList.length > 0) {
        color = isMine ? '#4c1d95' : '#94a3b8'
        weight = isMine ? 3 : 1.5
        fillColor = isMine ? '#c4b5fd' : '#cbd5e1'
        fillOpacity = isMine ? 0.34 : 0.07
      } else {
        color = '#94a3b8'
        weight = 1.5
        fillColor = '#cbd5e1'
        fillOpacity = 0.06
      }
      const layer = L.polygon(
        fence.geometry.coordinates[0].map(([lng, lat]) => [lat, lng] as [number, number]),
        {
          pane: 'geofencePane',
          color,
          weight,
          fillColor,
          fillOpacity,
        },
      ) as L.Polygon & { geofenceId?: string }
      layer.geofenceId = fence.id
      if (allowGeofenceSelect) {
        layer.on('click', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e)
          onSelect(fence.id)
        })
      }
      group.addLayer(layer)
    })
  }, [map, geofences, onSelect, allowGeofenceSelect, assignedGeofenceIdList])

  useEffect(() => {
    const block = () => {
      blockGeofenceClearOnMapClickRef.current = true
    }
    const unblock = () => {
      blockGeofenceClearOnMapClickRef.current = false
    }
    map.on(L.Draw.Event.DRAWSTART, block)
    map.on(L.Draw.Event.DRAWSTOP, unblock)
    map.on(L.Draw.Event.CREATED, unblock)
    map.on(L.Draw.Event.EDITSTART, block)
    map.on(L.Draw.Event.EDITSTOP, unblock)
    map.on(L.Draw.Event.EDITED, unblock)
    map.on(L.Draw.Event.DELETESTART, block)
    map.on(L.Draw.Event.DELETESTOP, unblock)
    map.on(L.Draw.Event.DELETED, unblock)
    map.on(L.Draw.Event.TOOLBARCLOSED, unblock)
    return () => {
      map.off(L.Draw.Event.DRAWSTART, block)
      map.off(L.Draw.Event.DRAWSTOP, unblock)
      map.off(L.Draw.Event.CREATED, unblock)
      map.off(L.Draw.Event.EDITSTART, block)
      map.off(L.Draw.Event.EDITSTOP, unblock)
      map.off(L.Draw.Event.EDITED, unblock)
      map.off(L.Draw.Event.DELETESTART, block)
      map.off(L.Draw.Event.DELETESTOP, unblock)
      map.off(L.Draw.Event.DELETED, unblock)
      map.off(L.Draw.Event.TOOLBARCLOSED, unblock)
    }
  }, [map])

  useEffect(() => {
    if (!allowGeofenceSelect) {
      return
    }
    const onMapClick = () => {
      if (blockGeofenceClearOnMapClickRef.current) {
        return
      }
      onSelect('')
    }
    map.on('click', onMapClick)
    return () => {
      map.off('click', onMapClick)
    }
  }, [map, allowGeofenceSelect, onSelect])

  useEffect(() => {
    if (!featureGroupRef.current) return

    const removeDrawControl = () => {
      if (drawControlRef.current) {
        map.removeControl(drawControlRef.current)
        drawControlRef.current = null
      }
    }

    if (!enabled) {
      removeDrawControl()
      return removeDrawControl
    }

    // Rebuild so edit/delete only appear with a selection, and Strict Mode never stacks duplicates.
    removeDrawControl()

    const showEditToolbar = Boolean(selectedGeofenceId)
    const group = featureGroupRef.current

    drawControlRef.current = new L.Control.Draw({
      draw: {
        polygon: {},
        rectangle: false,
        polyline: false,
        marker: false,
        circle: false,
        circlemarker: false,
      },
      ...(showEditToolbar
        ? {
            edit: {
              featureGroup: group,
              edit: {},
              remove: true,
            },
          }
        : {}),
    })
    map.addControl(drawControlRef.current)

    return removeDrawControl
  }, [map, enabled, selectedGeofenceId])

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

function GeofenceMarkCanvassedIcon() {
  return (
    <svg
      className="geofence-mark-canvassed-svg"
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
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9" />
    </svg>
  )
}

function MapHelpInfoIcon() {
  return (
    <svg
      className="map-help-info-svg"
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
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

function NearbyAddressSheet({
  memberIds,
  addresses,
  role,
  geofences,
  assignedGeofenceIdSet,
  onClose,
  onToggle,
}: {
  memberIds: string[]
  addresses: AddressRow[]
  role: string
  geofences: GeofenceRow[]
  assignedGeofenceIdSet: Set<string>
  onClose: () => void
  onToggle: (row: AddressRow) => void
}) {
  const rows = useMemo(
    () =>
      memberIds
        .map((id) => addresses.find((a) => a.id === id))
        .filter((a): a is AddressRow => a != null),
    [memberIds, addresses],
  )
  const sheetStreetGroups = useMemo(() => buildStreetGroups(rows), [rows])

  return (
    <div
      className="nearby-sheet-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        className="nearby-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nearby-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="nearby-sheet-header">
          <h2 id="nearby-sheet-title">Addresses here</h2>
          <button type="button" className="nearby-sheet-close" aria-label="Close list" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="nearby-sheet-subtitle">
          {rows.length} at this spot, grouped by street. Mark each unit as you go.
        </p>
        <div className="nearby-sheet-streets">
          {sheetStreetGroups.map((group, streetIndex) => (
            <CollapsibleStreetBlock
              key={group.sortKey}
              blockClassName="nearby-sheet-street"
              defaultOpen={sheetStreetGroups.length <= 4 || streetIndex < 2}
              summaryClassName="nearby-sheet-street-summary"
              nameClassName="nearby-sheet-street-name"
              metaClassName="nearby-sheet-street-meta"
              heading={group.heading}
              meta={`${group.rows.filter((a) => a.canvassed).length}/${group.rows.length} done`}
            >
              <ul className="nearby-sheet-list">
                {group.rows.map((address) => {
                  const canToggle =
                    role === 'admin' ||
                    (role === 'canvasser' &&
                      addressInAssignedGeofences(address, geofences, assignedGeofenceIdSet))
                  return (
                    <li key={address.id} className="nearby-sheet-row">
                      <div className="nearby-sheet-row-text">
                        <span className="nearby-sheet-address">{address.full_address}</span>
                        <span className={`nearby-sheet-pill ${address.canvassed ? 'done' : 'todo'}`}>
                          {address.canvassed ? 'Canvassed' : 'Not canvassed'}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="nearby-sheet-action"
                        disabled={!canToggle}
                        onClick={() => void onToggle(address)}
                      >
                        {role === 'admin'
                          ? address.canvassed
                            ? 'Mark uncanvassed'
                            : 'Mark canvassed'
                          : canToggle
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
      </div>
    </div>
  )
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<string>('')
  const [authStep, setAuthStep] = useState<'email' | 'email-instructions' | 'password'>('email')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [resetPasswordDraft, setResetPasswordDraft] = useState('')
  const [resetPasswordConfirmDraft, setResetPasswordConfirmDraft] = useState('')
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)
  const [addresses, setAddresses] = useState<AddressRow[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [viewport, setViewport] = useState<ViewportBounds | null>(null)
  const [hitViewportLimit, setHitViewportLimit] = useState(false)
  const [accessRows, setAccessRows] = useState<AccessRow[]>([])
  const [isProfilesLoading, setIsProfilesLoading] = useState(false)
  const [isAddingUser, setIsAddingUser] = useState(false)
  const [addUserModalOpen, setAddUserModalOpen] = useState(false)
  const [openAccessActionsEmail, setOpenAccessActionsEmail] = useState('')
  const [accessMessage, setAccessMessage] = useState('')
  const [newProfileName, setNewProfileName] = useState('')
  const [newProfileEmail, setNewProfileEmail] = useState('')
  const [newProfileRole, setNewProfileRole] = useState<'admin' | 'canvasser'>('canvasser')
  const [editingUserEmail, setEditingUserEmail] = useState('')
  const [editingUserNameDraft, setEditingUserNameDraft] = useState('')
  const [editingUserEmailDraft, setEditingUserEmailDraft] = useState('')
  const [editingUserRoleDraft, setEditingUserRoleDraft] = useState<'admin' | 'canvasser'>('canvasser')
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
  const [dotsEnabled, setDotsEnabled] = useState(true)
  const [addressPopupOpenId, setAddressPopupOpenId] = useState<string | null>(null)
  const [nearbyAddressSheet, setNearbyAddressSheet] = useState<{ memberIds: string[] } | null>(null)
  const [canvasserUiView, setCanvasserUiView] = useState<'map' | 'list'>('map')
  const [canvasserListAddresses, setCanvasserListAddresses] = useState<AddressRow[] | null>(null)
  const [isCanvasserListLoading, setIsCanvasserListLoading] = useState(false)
  const [canvasserListFetchError, setCanvasserListFetchError] = useState('')
  const [canvasserMobileAreasPanelExpanded, setCanvasserMobileAreasPanelExpanded] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(min-width: 901px)').matches
  })
  const [adminGeofencePanelExpanded, setAdminGeofencePanelExpanded] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.matchMedia('(min-width: 901px)').matches
  })
  const [canvasserMapHelpOpen, setCanvasserMapHelpOpen] = useState(false)
  const canvasserMapHelpRef = useRef<HTMLDivElement>(null)
  const accessActionsMenuRef = useRef<HTMLDivElement>(null)
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
  /** Canvassers: only dots inside assigned geofences. No assignment → no dots. Admins: all in view. */
  const addressesForMapDots = useMemo(() => {
    if (role !== 'canvasser') {
      return validAddresses
    }
    if (assignedGeofenceIdList.length === 0) {
      return []
    }
    return validAddresses.filter((address) =>
      addressInAssignedGeofences(address, geofences, assignedGeofenceIdSet),
    )
  }, [role, validAddresses, assignedGeofenceIdList, geofences, assignedGeofenceIdSet])
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
  const buildAccessRows = (
    accessData: {
      email: string
      role: 'admin' | 'canvasser'
      first_name: string | null
      last_name: string | null
    }[] | null,
    profileData: { email: string; role?: 'admin' | 'canvasser' }[] | null,
  ): AccessRow[] => {
    const byEmail = new Map<string, AccessRow>()
    const profiles = profileData ?? []
    const activeEmails = new Set(profiles.map((row) => row.email.toLowerCase()))

    ;(accessData ?? []).forEach((row) => {
      byEmail.set(row.email.toLowerCase(), {
        email: row.email,
        role: row.role,
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        status: (activeEmails.has(row.email.toLowerCase()) ? 'active' : 'pending') as
          | 'active'
          | 'pending',
      })
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
      .select('email,role,first_name,last_name')
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
        (accessData as {
          email: string
          role: 'admin' | 'canvasser'
          first_name: string | null
          last_name: string | null
        }[] | null) ?? [],
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
    } = supabase.auth.onAuthStateChange((event, currentSession) => {
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && hasResetPasswordIntentInUrl())) {
        setIsPasswordRecovery(true)
      } else if (event === 'SIGNED_OUT') {
        setIsPasswordRecovery(false)
      }
      setSession(currentSession)
      setRole('')
      setAddresses([])
      setErrorMessage('')
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (hasResetPasswordIntentInUrl()) {
      setIsPasswordRecovery(true)
    }
  }, [])

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
    const fetchAddresses = async () => {
      if (!supabase || !session?.user || !APP_ROLES.has(role) || !viewport) {
        return
      }

      const centerLat = (viewport.south + viewport.north) / 2
      const centerLng = (viewport.west + viewport.east) / 2

      const { count: bboxCount, error: countError } = await supabase
        .from('addresses')
        .select('id', { count: 'exact', head: true })
        .gte('lat', viewport.south)
        .lte('lat', viewport.north)
        .gte('long', viewport.west)
        .lte('long', viewport.east)

      if (countError) {
        setErrorMessage(countError.message)
        setAddresses([])
        setHitViewportLimit(false)
        return
      }

      const matchedCount = bboxCount ?? 0

      const rpcResult = await supabase.rpc('addresses_in_viewport_by_proximity', {
        south: viewport.south,
        north: viewport.north,
        west: viewport.west,
        east: viewport.east,
        clat: centerLat,
        clong: centerLng,
        row_limit: VIEWPORT_LIMIT,
      })

      let rows: AddressRow[]
      if (rpcResult.error) {
        const { data, error } = await supabase
          .from('addresses')
          .select('id,full_address,lat,long,canvassed')
          .gte('lat', viewport.south)
          .lte('lat', viewport.north)
          .gte('long', viewport.west)
          .lte('long', viewport.east)
          .limit(VIEWPORT_LIMIT)
        if (error) {
          setErrorMessage(error.message)
          setAddresses([])
          setHitViewportLimit(false)
          return
        }
        rows = (data as AddressRow[]) ?? []
      } else {
        rows = (rpcResult.data as AddressRow[]) ?? []
      }

      setHitViewportLimit(role === 'admin' && matchedCount > rows.length)
      setAddresses(rows)
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
    const mq = window.matchMedia('(max-width: 900px)')
    const onChange = () => {
      if (mq.matches) {
        setCanvasserMobileAreasPanelExpanded(false)
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
    if (!selectedGeofence) {
      setGeofenceProgress(null)
      return
    }
    setGeofenceNameDraft(selectedGeofence.name)
    setGeofenceEmailDraft(selectedGeofence.assigned_email ?? '')
  }, [selectedGeofenceId, selectedGeofence?.name, selectedGeofence?.assigned_email])

  useEffect(() => {
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
  }, [selectedGeofenceId, geofences, supabase])

  useEffect(() => {
    setMarkAllCompleteDialogOpen(false)
    setGeofencePanelMenuOpen(false)
    setAssigneePickerOpen(false)
    setGeofenceMessage('')
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
  }, [addUserModalOpen, isAddingUser])

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
  }, [openAccessActionsEmail])

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
        ? await supabase.from('addresses').update({ canvassed: nextState }).eq('id', address.id)
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
      setErrorMessage(missingSupabaseConfig)
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
    setIsAuthSubmitting(true)
    setAuthMessage('')
    const { error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    })
    setIsAuthSubmitting(false)

    if (error) {
      setAuthMessage('Invalid email or password.')
      return
    }
  }

  const continueWithEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      setErrorMessage(missingSupabaseConfig)
      return
    }

    const normalizedEmail = authEmail.trim().toLowerCase()
    if (!normalizedEmail) {
      setAuthMessage('Enter your email address.')
      return
    }
    const canAttempt = await canAttemptEmailAuth(normalizedEmail)
    setAuthEmail(normalizedEmail)
    setAuthPassword('')
    setAuthStep(canAttempt ? 'password' : 'email-instructions')
    setAuthMessage('')
  }

  const sendPasswordResetEmail = async () => {
    if (!supabase) {
      setErrorMessage(missingSupabaseConfig)
      return
    }

    const normalizedEmail = authEmail.trim().toLowerCase()
    if (!normalizedEmail) {
      setAuthMessage('Enter your email address to reset your password.')
      return
    }

    setIsAuthSubmitting(true)
    setAuthMessage('')
    const redirectTo = getAuthRedirectUrl(`/?${RESET_PASSWORD_QUERY_KEY}=1`)
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
      setErrorMessage(missingSupabaseConfig)
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
      url.searchParams.delete(RESET_PASSWORD_QUERY_KEY)
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }
    setResetPasswordDraft('')
    setResetPasswordConfirmDraft('')
    setAuthPassword('')
    setAuthStep('email')
    setAuthMessage('Password updated. Sign in with your new password.')
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
    const { firstName, lastName } = splitFullName(newProfileName)
    if (!firstName) {
      setAccessMessage('Name is required.')
      return
    }
    if (!email) {
      setAccessMessage('Email is required.')
      return
    }

    setIsAddingUser(true)
    const { error } = await supabase.rpc('admin_set_user_access', {
      target_email: email,
      target_role: newProfileRole,
      target_first_name: firstName,
      target_last_name: lastName,
    })
    setIsAddingUser(false)

    if (error) {
      setAccessMessage(error.message)
      return
    }

    setAccessMessage('Access saved. User can now create an account with this email.')
    setNewProfileName('')
    setNewProfileEmail('')
    setNewProfileRole('canvasser')
    setAddUserModalOpen(false)

    await refreshAccessList()
  }

  const startEditUser = (entry: AccessRow) => {
    setEditingUserEmail(entry.email)
    setEditingUserNameDraft(accessDisplayName(entry))
    setEditingUserEmailDraft(entry.email)
    setEditingUserRoleDraft(entry.role)
    setOpenAccessActionsEmail('')
    setAccessMessage('')
  }

  const cancelEditUser = () => {
    setEditingUserEmail('')
    setEditingUserNameDraft('')
    setEditingUserEmailDraft('')
    setEditingUserRoleDraft('canvasser')
  }

  const saveEditedUser = async (currentEmail: string) => {
    if (!supabase || role !== 'admin') {
      return
    }

    const nextEmail = editingUserEmailDraft.trim().toLowerCase()
    const { firstName, lastName } = splitFullName(editingUserNameDraft)
    if (!firstName) {
      setAccessMessage('Name is required.')
      return
    }
    if (!nextEmail) {
      setAccessMessage('Email is required.')
      return
    }

    if (nextEmail !== currentEmail.toLowerCase()) {
      const { error } = await supabase.rpc('admin_update_user_email', {
        old_email: currentEmail.toLowerCase(),
        new_email: nextEmail,
      })
      if (error) {
        setAccessMessage(error.message)
        return
      }
    }

    const { error } = await supabase.rpc('admin_set_user_access', {
      target_email: nextEmail,
      target_role: editingUserRoleDraft,
      target_first_name: firstName,
      target_last_name: lastName,
    })
    if (error) {
      setAccessMessage(error.message)
      return
    }

    setAccessMessage('User updated.')
    cancelEditUser()
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
    setAccessRows((current) =>
      current.filter((entry) => entry.email.toLowerCase() !== targetEmail.toLowerCase()),
    )
    if (editingUserEmail.toLowerCase() === targetEmail.toLowerCase()) {
      cancelEditUser()
    }
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
            <input
              id="recovery-password"
              type="password"
              autoComplete="new-password"
              value={resetPasswordDraft}
              onChange={(event) => setResetPasswordDraft(event.target.value)}
              placeholder="At least 8 characters"
            />
            <label htmlFor="recovery-confirm-password">Confirm new password</label>
            <input
              id="recovery-confirm-password"
              type="password"
              autoComplete="new-password"
              value={resetPasswordConfirmDraft}
              onChange={(event) => setResetPasswordConfirmDraft(event.target.value)}
              placeholder="Re-enter new password"
            />
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
                : `Sign in for ${authEmail.trim().toLowerCase()}.`}
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
                    setAuthMessage('')
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
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  placeholder="Enter password"
                />
              </div>
              <button
                type="button"
                className="auth-inline-link"
                disabled={isAuthSubmitting}
                onClick={() => void sendPasswordResetEmail()}
              >
                Forgot password?
              </button>
              <div className="auth-actions">
                <button type="submit" className="auth-primary-button" disabled={isAuthSubmitting}>
                  {isAuthSubmitting ? 'Submitting...' : 'Sign in'}
                </button>
                <button
                  type="button"
                  className="auth-secondary-button"
                  disabled={isAuthSubmitting}
                  onClick={() => {
                    setAuthPassword('')
                    setAuthMessage('')
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
        <p className="top-bar-subtitle">
          Map{role ? ` · ${role}` : ''}
        </p>
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
                              radius={CANVASSER_ADDRESS_HIT_RADIUS_PX}
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
                          <CircleMarker
                            key={`${address.id}-marker`}
                            center={[address.lat, address.long]}
                            pane="addressPane"
                            radius={visualRadius}
                            pathOptions={visualPathOptions}
                            eventHandlers={popupOpenHandlers}
                          >
                            <Popup>{popupContent}</Popup>
                          </CircleMarker>
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
                        icon={createClusterCountIcon(members.length, allCanvassed)}
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
              className={`geofence-panel canvasser-areas-panel${
                canvasserMobileAreasPanelExpanded ? ' canvasser-areas-panel--expanded' : ''
              }`}
              aria-label="Your assigned areas"
            >
              <button
                type="button"
                className="canvasser-areas-mobile-strip"
                aria-expanded={canvasserMobileAreasPanelExpanded}
                aria-controls="canvasser-areas-expandable"
                onClick={() => setCanvasserMobileAreasPanelExpanded((open) => !open)}
                aria-label={
                  canvasserMobileAreasPanelExpanded
                    ? 'Hide assigned areas breakdown'
                    : 'Show assigned areas breakdown, counts and progress'
                }
              >
                <div className="canvasser-areas-strip-row">
                  <span className="canvasser-areas-strip-title">{canvasserAreasTitle}</span>
                  {assignedGeofenceIdList.length === 0 ? (
                    <span className="canvasser-areas-strip-meta">No area assigned</span>
                  ) : isCanvasserListLoading ? (
                    <span className="canvasser-areas-strip-meta">Loading…</span>
                  ) : canvasserListFetchError ? (
                    <span className="canvasser-areas-strip-meta">Error · tap for details</span>
                  ) : canvasserListProgress ? (
                    <span className="canvasser-areas-strip-meta">
                      {canvasserListProgress.done}/{canvasserListProgress.total} canvassed ·{' '}
                      {canvasserListProgress.percent}%
                    </span>
                  ) : (
                    <span className="canvasser-areas-strip-meta">0/0 canvassed</span>
                  )}
                  <span className="canvasser-areas-strip-chevron" aria-hidden="true">
                    {canvasserMobileAreasPanelExpanded ? '▲' : '▼'}
                  </span>
                </div>
                {assignedGeofenceIdList.length > 0 &&
                !isCanvasserListLoading &&
                !canvasserListFetchError ? (
                  <div className="canvasser-areas-strip-bar" aria-hidden="true">
                    <div
                      className="canvasser-areas-strip-bar-fill"
                      style={{ width: `${canvasserListProgress?.percent ?? 0}%` }}
                    />
                  </div>
                ) : null}
              </button>

              <div id="canvasser-areas-expandable" className="canvasser-areas-expandable">
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
                        <span>Progress</span>
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
                      <td className="profiles-actions-cell" data-label="Actions">
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
