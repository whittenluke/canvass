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
const VIEWPORT_LIMIT = 4000
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
  const [authEmail, setAuthEmail] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [isSendingLink, setIsSendingLink] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)
  const [addresses, setAddresses] = useState<AddressRow[]>([])
  const [errorMessage, setErrorMessage] = useState('')
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
  const [canvasserMapHelpOpen, setCanvasserMapHelpOpen] = useState(false)
  const canvasserMapHelpRef = useRef<HTMLDivElement>(null)
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
        setHitViewportLimit(false)
      } else {
        const rows = (data as AddressRow[]) ?? []
        const matchedCount = count ?? rows.length
        setHitViewportLimit(matchedCount > rows.length)
        setAddresses(rows)
      }

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

  const centerPoint = useMemo<[number, number]>(() => RURAL_HALL_CENTER, [])
  const isCloseZoom = (viewport?.zoom ?? 13) >= ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM
  const dotsVisibleMinZoom = role === 'admin' ? DOTS_VISIBLE_MIN_ZOOM_ADMIN : DOTS_VISIBLE_MIN_ZOOM_CANVASSER
  const showAddressDots = dotsEnabled && (viewport?.zoom ?? 13) >= dotsVisibleMinZoom

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
      setAuthMessage(
        'Login blocked by VITE_ALLOWED_LOGIN_EMAILS: this email is not on that list. Netlify → Site configuration → Environment variables → add it (comma-separated) or delete the variable to turn the list off.',
      )
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
      setAuthMessage(
        'Login blocked by database: no row in user_access for this email. Supabase → Table editor → user_access → New row (email + admin or canvasser). Or run the INSERT from documentation/schema.sql.',
      )
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
      const raw = error.message
      const signupsBlocked = /signups not allowed/i.test(raw)
      setAuthMessage(
        signupsBlocked
          ? 'Your email is already in Admin Access (the app database), but Supabase Auth is blocking the first magic link because it would create a new login user. In Supabase Dashboard → Authentication → Email: allow new sign-ups, or add each person under Authentication → Users (invite), then send the magic link again.'
          : raw,
      )
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
            <MapContainer center={centerPoint} zoom={13} scrollWheelZoom className="map-view">
              <MapPaneSetup />
              {role === 'admin' && selectedGeofence && (
                <div className="selected-geofence-chip">
                  Selected: {selectedGeofence.name}
                  {selectedGeofence.assigned_email ? ` (${selectedGeofence.assigned_email})` : ''}
                </div>
              )}
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
                geofences={geofences}
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
                  <span className="canvasser-areas-strip-title">Assigned areas</span>
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
                  <h3>Your assigned areas</h3>
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
                        <span>Canvassed</span>
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
                    <div className="metric-grid compact">
                      <div className="metric-card emphasis canvasser-areas-metric-emphasis">
                        <span>Remaining</span>
                        <strong>{canvasserListProgress.total - canvasserListProgress.done}</strong>
                      </div>
                      <div className="metric-card canvasser-areas-metric">
                        <span>Done</span>
                        <strong>{canvasserListProgress.done}</strong>
                      </div>
                      <div className="metric-card canvasser-areas-metric">
                        <span>Total</span>
                        <strong>{canvasserListProgress.total}</strong>
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
      ) : null}
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
