import buffer from '@turf/buffer'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point, polygon as turfPolygon } from '@turf/helpers'
import type { AddressRow } from '../app/types'

/** Display label distance for Hot Zone buffer analysis. */
export const HOT_ZONE_BUFFER_FEET = 500

/** Distance used when computing the buffer polygon / address classification. */
export const HOT_ZONE_BUFFER_FEET_CALC = 550

/** Extra fetch padding beyond the buffer bbox for outside-buffer map dots (not whole-map). */
export const HOT_ZONE_OUTSIDE_FETCH_PAD_FEET = 2640

const FEET_PER_METER = 3.280839895
const METERS_PER_FOOT = 1 / FEET_PER_METER

export function feetToKilometers(feet: number): number {
  return (feet * METERS_PER_FOOT) / 1000
}

/**
 * Expand a polygon outward by `feet` from the exterior edge (Turf buffer).
 * Returns null if the input is invalid or the buffer fails.
 */
export function bufferPolygonFeet(
  geometry: GeoJSON.Polygon,
  feet: number = HOT_ZONE_BUFFER_FEET_CALC,
): GeoJSON.Polygon | null {
  const ring = geometry.coordinates[0]
  if (!ring || ring.length < 4) return null
  try {
    const feature = turfPolygon(geometry.coordinates)
    const buffered = buffer(feature, feetToKilometers(feet), { units: 'kilometers' })
    if (!buffered?.geometry) return null
    if (buffered.geometry.type === 'Polygon') {
      return buffered.geometry
    }
    // Rare MultiPolygon: take the largest ring set by coordinate count.
    if (buffered.geometry.type === 'MultiPolygon') {
      const polys = buffered.geometry.coordinates
      let best = polys[0]
      for (const p of polys) {
        if ((p[0]?.length ?? 0) > (best[0]?.length ?? 0)) best = p
      }
      return { type: 'Polygon', coordinates: best }
    }
    return null
  } catch {
    return null
  }
}

export function polygonBBox(geometry: GeoJSON.Polygon): {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
} | null {
  const ring = geometry.coordinates[0]
  if (!ring || ring.length === 0) return null
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const [lng, lat] of ring) {
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
    minLng = Math.min(minLng, lng)
    maxLng = Math.max(maxLng, lng)
  }
  if (!Number.isFinite(minLat)) return null
  return { minLat, maxLat, minLng, maxLng }
}

/** Expand a lat/lng bbox outward by roughly `feet` on each side. */
export function expandBBoxFeet(
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  feet: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const midLat = (bbox.minLat + bbox.maxLat) / 2
  const degLat = feet / (FEET_PER_METER * 111_320)
  const cos = Math.max(Math.cos((midLat * Math.PI) / 180), 0.2)
  const degLng = feet / (FEET_PER_METER * 111_320 * cos)
  return {
    minLat: bbox.minLat - degLat,
    maxLat: bbox.maxLat + degLat,
    minLng: bbox.minLng - degLng,
    maxLng: bbox.maxLng + degLng,
  }
}

export type HotZoneAddressSets = {
  inBoundary: AddressRow[]
  /** Inside 500 ft buffer but outside the project boundary. */
  inBufferOnly: AddressRow[]
  /** Outside the buffer entirely (still in the fetch bbox). */
  outsideBuffer: AddressRow[]
  bufferGeometry: GeoJSON.Polygon | null
}

export function classifyHotZoneAddresses(
  addresses: AddressRow[],
  boundary: GeoJSON.Polygon,
  bufferGeometry: GeoJSON.Polygon | null,
): HotZoneAddressSets {
  const inBoundary: AddressRow[] = []
  const inBufferOnly: AddressRow[] = []
  const outsideBuffer: AddressRow[] = []
  for (const row of addresses) {
    const pt = point([row.long, row.lat])
    const insideBoundary = booleanPointInPolygon(pt, boundary)
    if (insideBoundary) {
      inBoundary.push(row)
      continue
    }
    if (bufferGeometry && booleanPointInPolygon(pt, bufferGeometry)) {
      inBufferOnly.push(row)
      continue
    }
    outsideBuffer.push(row)
  }
  const byAddress = (a: AddressRow, b: AddressRow) =>
    a.full_address.localeCompare(b.full_address)
  inBoundary.sort(byAddress)
  inBufferOnly.sort(byAddress)
  outsideBuffer.sort(byAddress)
  return { inBoundary, inBufferOnly, outsideBuffer, bufferGeometry }
}

export function exportHotZoneAddressesCsv(
  rows: AddressRow[],
  sourceView: 'Project Boundary' | '500 ft Buffer',
): string {
  const exportDate = new Date().toISOString().slice(0, 10)
  const escape = (value: string) => {
    if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
    return value
  }
  const header = [
    'Address',
    'Latitude',
    'Longitude',
    'Parcel ID',
    'Canvass status',
    'Assigned user',
    'Source view',
    'Export date',
  ]
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        escape(row.full_address),
        String(row.lat),
        String(row.long),
        '',
        row.canvassed ? 'canvassed' : 'not canvassed',
        '',
        escape(sourceView),
        exportDate,
      ].join(','),
    )
  }
  return lines.join('\n')
}

export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
