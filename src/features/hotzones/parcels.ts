import type { Feature, FeatureCollection, Geometry, Polygon, MultiPolygon } from 'geojson'

export const HOT_ZONE_PARCELS_URL = '/data/parcels-rural-hall-downtown.geojson'

/** Avoid painting tens of thousands of polygons when zoomed out. */
export const PARCEL_RENDER_MIN_ZOOM = 14
export const PARCEL_RENDER_MAX_FEATURES = 3500

type ParcelProps = {
  OBJECTID?: number
  PARCEL_PK?: number
  PIN?: string
  TAXPIN?: string
  REID?: string
  PROPERTYADDRESS?: string
}

export type ParcelFeature = Feature<Polygon | MultiPolygon, ParcelProps>

let parcelsPromise: Promise<FeatureCollection<Geometry, ParcelProps> | null> | null = null

export function loadHotZoneParcels(): Promise<FeatureCollection<Geometry, ParcelProps> | null> {
  if (!parcelsPromise) {
    parcelsPromise = fetch(HOT_ZONE_PARCELS_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load parcels (${res.status})`)
        return (await res.json()) as FeatureCollection<Geometry, ParcelProps>
      })
      .catch((err) => {
        console.error(err)
        parcelsPromise = null
        return null
      })
  }
  return parcelsPromise
}

function geometryBBox(geometry: Geometry): {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
} | null {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords) || coords.length === 0) return
    if (typeof coords[0] === 'number') {
      const lng = coords[0] as number
      const lat = coords[1] as number
      minLng = Math.min(minLng, lng)
      maxLng = Math.max(maxLng, lng)
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
      return
    }
    for (const c of coords) walk(c)
  }
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries) walk((g as Geometry & { coordinates?: unknown }).coordinates)
  } else if ('coordinates' in geometry) {
    walk(geometry.coordinates)
  }
  if (!Number.isFinite(minLng)) return null
  return { minLng, minLat, maxLng, maxLat }
}

export function filterParcelsInBounds(
  collection:
    | FeatureCollection<Geometry, ParcelProps>
    | { type: 'FeatureCollection'; features: ParcelFeature[] },
  bounds: { west: number; south: number; east: number; north: number },
  maxFeatures = PARCEL_RENDER_MAX_FEATURES,
): ParcelFeature[] {
  const out: ParcelFeature[] = []
  for (const feature of collection.features) {
    if (!feature.geometry) continue
    if (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon') continue
    const bb = geometryBBox(feature.geometry)
    if (!bb) continue
    if (
      bb.maxLng < bounds.west ||
      bb.minLng > bounds.east ||
      bb.maxLat < bounds.south ||
      bb.minLat > bounds.north
    ) {
      continue
    }
    out.push(feature as ParcelFeature)
    if (out.length >= maxFeatures) break
  }
  return out
}
