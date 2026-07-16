/**
 * One-time clip: Forsyth county parcels → Rural Hall + downtown Winston-Salem corridor.
 * Streams the source so we don't load ~300MB into memory at once.
 *
 * Usage:
 *   node scripts/clip-parcels-corridor.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const INPUT = path.join(root, 'Data', 'Parcels_Hosted_-4457774019757453921.geojson')
const OUTPUT = path.join(root, 'public', 'data', 'parcels-rural-hall-downtown.geojson')

/**
 * Two focused areas: Rural Hall (where Hot Zone lives) + downtown Winston-Salem.
 * Keeps parcels around both without the full Forsyth corridor.
 */
const CLIP_REGIONS = [
  // Rural Hall / Bethania area
  { west: -80.34, east: -80.24, south: 36.20, north: 36.28 },
  // Downtown Winston-Salem
  { west: -80.28, east: -80.20, south: 36.08, north: 36.14 },
]

function bboxIntersectsAnyClip(minLng, minLat, maxLng, maxLat) {
  return CLIP_REGIONS.some(
    (c) =>
      !(maxLng < c.west || minLng > c.east || maxLat < c.south || minLat > c.north),
  )
}

const KEEP_PROPS = [
  'OBJECTID',
  'PARCEL_PK',
  'PIN',
  'TAXPIN',
  'REID',
  'PROPERTYADDRESS',
]

function featureBBox(geometry) {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  const walk = (coords) => {
    if (!Array.isArray(coords) || coords.length === 0) return
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords
      minLng = Math.min(minLng, lng)
      maxLng = Math.max(maxLng, lng)
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
      return
    }
    for (const c of coords) walk(c)
  }
  walk(geometry?.coordinates)
  if (!Number.isFinite(minLng)) return null
  return { minLng, minLat, maxLng, maxLat }
}

function roundCoord(n) {
  return Math.round(n * 1e6) / 1e6
}

function simplifyGeometry(geometry) {
  if (!geometry) return geometry
  const walk = (coords) => {
    if (!Array.isArray(coords) || coords.length === 0) return coords
    if (typeof coords[0] === 'number') {
      return [roundCoord(coords[0]), roundCoord(coords[1])]
    }
    return coords.map(walk)
  }
  return {
    type: geometry.type,
    coordinates: walk(geometry.coordinates),
  }
}

function slimFeature(feature) {
  const props = feature.properties ?? {}
  const slim = {}
  for (const key of KEEP_PROPS) {
    if (props[key] != null && props[key] !== '') slim[key] = props[key]
  }
  return {
    type: 'Feature',
    id: feature.id ?? slim.OBJECTID ?? slim.PARCEL_PK,
    geometry: simplifyGeometry(feature.geometry),
    properties: slim,
  }
}

function extractNextFeature(buffer, startIdx) {
  // Find next `{` that starts a Feature object inside the features array.
  let i = startIdx
  while (i < buffer.length) {
    const open = buffer.indexOf('{', i)
    if (open === -1) return null
    let depth = 0
    let inString = false
    let escape = false
    for (let j = open; j < buffer.length; j++) {
      const ch = buffer[j]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const raw = buffer.slice(open, j + 1)
          return { raw, nextIdx: j + 1 }
        }
      }
    }
    // Incomplete object — need more data
    return { incomplete: true, nextIdx: open }
  }
  return null
}

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error('Missing input:', INPUT)
    process.exit(1)
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })

  const out = fs.createWriteStream(OUTPUT)
  out.write('{"type":"FeatureCollection","features":[')

  const stream = fs.createReadStream(INPUT, { encoding: 'utf8', highWaterMark: 1024 * 1024 })

  let buffer = ''
  let inFeatures = false
  let wroteAny = false
  let kept = 0
  let scanned = 0
  let skippedIncompleteAtEnd = false

  for await (const chunk of stream) {
    buffer += chunk

    if (!inFeatures) {
      const marker = '"features"'
      const mi = buffer.indexOf(marker)
      if (mi === -1) {
        // Keep a small tail in case marker straddles chunks
        if (buffer.length > 64) buffer = buffer.slice(-64)
        continue
      }
      const bracket = buffer.indexOf('[', mi)
      if (bracket === -1) continue
      buffer = buffer.slice(bracket + 1)
      inFeatures = true
    }

    while (true) {
      const extracted = extractNextFeature(buffer, 0)
      if (!extracted) {
        buffer = ''
        break
      }
      if (extracted.incomplete) {
        // Keep from the incomplete object onward
        buffer = buffer.slice(extracted.nextIdx)
        skippedIncompleteAtEnd = true
        break
      }
      skippedIncompleteAtEnd = false
      buffer = buffer.slice(extracted.nextIdx)

      let feature
      try {
        feature = JSON.parse(extracted.raw)
      } catch {
        continue
      }
      if (feature?.type !== 'Feature' || !feature.geometry) continue
      scanned++

      const bb = featureBBox(feature.geometry)
      if (!bb || !bboxIntersectsAnyClip(bb.minLng, bb.minLat, bb.maxLng, bb.maxLat)) continue

      const slim = slimFeature(feature)
      if (wroteAny) out.write(',')
      out.write(JSON.stringify(slim))
      wroteAny = true
      kept++

      if (kept % 500 === 0) {
        process.stdout.write(`\rscanned ${scanned}, kept ${kept}`)
      }
    }
  }

  // Drain any remaining complete features in buffer
  if (inFeatures && buffer.length > 0 && !skippedIncompleteAtEnd) {
    // nothing left that is complete
  }

  out.write(']}')
  await new Promise((resolve, reject) => {
    out.end(() => resolve())
    out.on('error', reject)
  })

  const stat = fs.statSync(OUTPUT)
  console.log(`\nDone. scanned=${scanned} kept=${kept}`)
  console.log(`Wrote ${OUTPUT} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`)
  console.log(
    `Clip regions: ${CLIP_REGIONS.map((c) => `[${c.west},${c.south},${c.east},${c.north}]`).join(' ')}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
