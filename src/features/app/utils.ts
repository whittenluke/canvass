import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
import type {
  AccessRow,
  AddressRow,
  GeofenceProgress,
  GeofenceRow,
  StreetAddressGroup,
  SupabaseClientNonNull,
  ViewportBounds,
} from './types'

export const RURAL_HALL_CENTER: [number, number] = [36.2413, -80.2937]
export const APP_ROLES = new Set(['admin', 'canvasser'])
export const VIEWPORT_LIMIT = 6000
export const DOTS_VISIBLE_MIN_ZOOM_CANVASSER = 15
export const DOTS_VISIBLE_MIN_ZOOM_ADMIN = 15
export const ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM = 17
export const CANVASSER_ADDRESS_HIT_RADIUS_LOOSE_PX = 26
export const ADDRESS_CLUSTER_MERGE_METERS = 12
export const ADDRESS_CLUSTER_CROSS_GAP_METERS = 22
export const APPROVED_LOGIN_EMAILS = (import.meta.env.VITE_ALLOWED_LOGIN_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean)
export const RESET_PASSWORD_QUERY_KEY = 'reset_password'
export const AUTH_REDIRECT_OVERRIDE = import.meta.env.VITE_AUTH_REDIRECT_URL?.trim()

const METERS_PER_DEGREE_LAT = 111_111

export function addressInAssignedGeofences(
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

export function splitFullName(fullName: string): { firstName: string | null; lastName: string | null } {
  const trimmed = fullName.trim()
  if (!trimmed) return { firstName: null, lastName: null }
  const parts = trimmed.split(/\s+/)
  const firstName = parts[0] ?? null
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null
  return { firstName, lastName }
}

export function accessDisplayName(entry: AccessRow): string {
  const first = entry.first_name?.trim() ?? ''
  const last = entry.last_name?.trim() ?? ''
  const full = `${first} ${last}`.trim()
  return full || entry.email
}

export async function fetchAddressStatsInsidePolygon(
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

export function streetHeadingFromFullAddress(fullAddress: string): string {
  const firstLine = fullAddress.split(',')[0]?.trim() ?? fullAddress.trim()
  const stripped = firstLine.replace(/^(\d+[A-Za-z]?(?:\s*-\s*\d+[A-Za-z]?)?)\s+/, '').trim()
  return stripped || firstLine
}

export function buildStreetGroups(addresses: AddressRow[]): StreetAddressGroup[] {
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
  const groups: StreetAddressGroup[] = [...bucket.entries()]
    .map(([sortKey, g]) => ({
      sortKey,
      heading: g.heading,
      rows: g.rows,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  for (const g of groups) {
    g.rows.sort((x, y) => x.full_address.localeCompare(y.full_address, undefined, { numeric: true }))
  }
  return groups
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const phi1 = (lat1 * Math.PI) / 180
  const phi2 = (lat2 * Math.PI) / 180
  const dPhi = ((lat2 - lat1) * Math.PI) / 180
  const dLambda = ((lng2 - lng1) * Math.PI) / 180
  const x =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2)
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

export function clusterAddressesByProximity(addresses: AddressRow[], maxDistanceM: number): AddressRow[][] {
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
      if (haversineMeters(addresses[i].lat, addresses[i].long, addresses[j].lat, addresses[j].long) <= maxDistanceM) {
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

export function crossClusterMinMeters(a: AddressRow[], b: AddressRow[]): number {
  let min = Infinity
  for (const pa of a) {
    for (const pb of b) {
      const d = haversineMeters(pa.lat, pa.long, pb.lat, pb.long)
      if (d < min) min = d
    }
  }
  return min
}

export function mergeClustersByCrossGap(clusters: AddressRow[][], maxGapM: number): AddressRow[][] {
  const list = clusters.map((c) => [...c])
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const minD = crossClusterMinMeters(list[i], list[j])
        if (minD <= maxGapM && (list[i].length >= 2 || list[j].length >= 2)) {
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

export function clusterAddressesByViewportGrid(
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

export function sortClustersSinglesFirst(clusters: AddressRow[][]): AddressRow[][] {
  const singles = clusters.filter((c) => c.length === 1)
  const multi = clusters.filter((c) => c.length > 1)
  return [...singles, ...multi]
}

export function addressHitIsGenerous(zoom: number): boolean {
  return zoom >= ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM
}

export function canvasserAddressHitRadiusPx(zoom: number): number {
  if (addressHitIsGenerous(zoom)) return CANVASSER_ADDRESS_HIT_RADIUS_LOOSE_PX
  if (zoom >= 16) return 15
  return 10
}

export function adminAddressHitRadiusPx(zoom: number, visualRadius: number): number {
  if (addressHitIsGenerous(zoom)) return visualRadius + 6
  return Math.max(4, visualRadius)
}

export function hasResetPasswordIntentInUrl(): boolean {
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

export function getAuthRedirectUrl(pathAndQuery: string): string {
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

export function isEmailAlreadyRegisteredSignupError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('already been registered') ||
    m.includes('already registered') ||
    m.includes('user already exists') ||
    m.includes('email address is already')
  )
}

export function isInvalidPasswordSignInError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('invalid login credentials') || m.includes('invalid email or password')
}
