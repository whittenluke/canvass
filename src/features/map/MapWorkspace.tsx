import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet-draw'
import { useMap, useMapEvents } from 'react-leaflet'
import { GEOFENCE_LABEL_MIN_ZOOM, VIEWPORT_LIMIT } from '../app/utils'
import type { GeofenceRow, HotZoneRow, ViewportBounds } from '../app/types'

type GeofencePolygonLayer = L.Polygon & {
  geofenceId?: string
  geofenceStructureKey?: string
}

type GeofenceStyleContext = {
  fenceId: string
  allowGeofenceSelect: boolean
  enabled: boolean
  assignedGeofenceIdList: string[]
  canvasserFocusedGeofenceId: string
  isMine: boolean
  /** Every in-area address is canvassed (total > 0). Uses map dot blue, darker than default purple. */
  allCanvassed: boolean
}

/** Match address-dot canvassed blue (#2563eb / #1d4ed8). */
const GEOFENCE_ALL_CANVASSED_STYLE = {
  color: '#1d4ed8',
  fillColor: '#2563eb',
  fillOpacity: 0.42,
} as const

const GEOFENCE_ALL_CANVASSED_DIMMED_STYLE = {
  color: '#2563eb',
  fillColor: '#60a5fa',
  fillOpacity: 0.34,
} as const

function withAllCanvassedStyle(
  base: L.PathOptions,
  allCanvassed: boolean,
  dimmed: boolean,
): L.PathOptions {
  if (!allCanvassed) return base
  const blue = dimmed ? GEOFENCE_ALL_CANVASSED_DIMMED_STYLE : GEOFENCE_ALL_CANVASSED_STYLE
  return {
    ...base,
    color: blue.color,
    fillColor: blue.fillColor,
    fillOpacity: blue.fillOpacity,
  }
}

function fenceLatLngs(fence: GeofenceRow): L.LatLngExpression[] {
  return fence.geometry.coordinates[0].map(([lng, lat]) => [lat, lng] as [number, number])
}

function fenceStructureKey(fence: GeofenceRow): string {
  const ring = fence.geometry.coordinates[0] ?? []
  let coordChecksum = 0
  for (const pt of ring) {
    coordChecksum += (pt[0] ?? 0) + (pt[1] ?? 0)
  }
  return `${fence.id}:${ring.length}:${coordChecksum.toFixed(6)}:${fence.name}`
}

function fenceLabelText(fence: GeofenceRow): string {
  return fence.name.trim() || 'Unnamed area'
}

function getGeofencePathOptions(context: GeofenceStyleContext): L.PathOptions {
  const {
    allowGeofenceSelect,
    enabled,
    assignedGeofenceIdList,
    canvasserFocusedGeofenceId,
    isMine,
    allCanvassed,
  } = context
  const canvasserPolygonPickMode = allowGeofenceSelect && !enabled

  if (allowGeofenceSelect && enabled) {
    return withAllCanvassedStyle(
      {
        color: '#4c1d95',
        weight: 3,
        fillColor: '#c4b5fd',
        fillOpacity: 0.34,
      },
      allCanvassed,
      false,
    )
  }
  if (canvasserPolygonPickMode && isMine) {
    const focused = canvasserFocusedGeofenceId
    const isFocusedLayer = Boolean(focused && context.fenceId === focused)
    const showBright = !focused || isFocusedLayer
    if (showBright) {
      return withAllCanvassedStyle(
        {
          color: '#4c1d95',
          weight: isFocusedLayer ? 4 : 3,
          fillColor: '#c4b5fd',
          fillOpacity: isFocusedLayer ? 0.42 : 0.34,
        },
        allCanvassed,
        false,
      )
    }
    return withAllCanvassedStyle(
      {
        color: '#7c3aed',
        weight: 2.5,
        fillColor: '#ddd6fe',
        fillOpacity: 0.32,
      },
      allCanvassed,
      true,
    )
  }
  if (assignedGeofenceIdList.length > 0) {
    return withAllCanvassedStyle(
      {
        color: isMine ? '#4c1d95' : '#94a3b8',
        weight: isMine ? 3 : 1.5,
        fillColor: isMine ? '#c4b5fd' : '#cbd5e1',
        fillOpacity: isMine ? 0.34 : 0.07,
      },
      allCanvassed,
      false,
    )
  }
  return withAllCanvassedStyle(
    {
      color: '#94a3b8',
      weight: 1.5,
      fillColor: '#cbd5e1',
      fillOpacity: 0.06,
    },
    allCanvassed,
    false,
  )
}

function setFenceTooltip(layer: GeofencePolygonLayer, fence: GeofenceRow) {
  const label = fenceLabelText(fence)
  const tooltip = layer.getTooltip()
  if (tooltip) {
    const content = tooltip.getContent()
    if (content instanceof HTMLElement) {
      content.textContent = label
      return
    }
    const el = tooltip.getElement()?.querySelector('.geofence-map-label-text')
    if (el) {
      el.textContent = label
      return
    }
  }
  const labelEl = document.createElement('span')
  labelEl.className = 'geofence-map-label-text'
  labelEl.textContent = label
  layer.bindTooltip(labelEl, {
    permanent: true,
    direction: 'center',
    className: 'geofence-map-label',
    interactive: false,
    opacity: 1,
  })
}

export function MapViewportWatcher({
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

export function MapPaneSetup() {
  const map = useMap()

  useEffect(() => {
    const hotZonePane = map.getPane('hotZonePane') ?? map.createPane('hotZonePane')
    hotZonePane.style.zIndex = '340'

    const geofencePane = map.getPane('geofencePane') ?? map.createPane('geofencePane')
    geofencePane.style.zIndex = '350'

    const addressPane = map.getPane('addressPane') ?? map.createPane('addressPane')
    addressPane.style.zIndex = '450'
  }, [map])

  return null
}

export function MapStatusLine({
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
    text = 'Click the dot icon to enable address dots.'
  } else if (!showAddressDots) {
    text = role === 'admin' ? 'Zoom in closer to show address dots' : 'Zoom in to see address dots.'
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

export function GeofenceDrawManager({
  geofences,
  enabled,
  allowGeofenceSelect,
  assignedGeofenceIdList,
  selectedGeofenceId,
  canvasserFocusedGeofenceId = '',
  geofenceAllCanvassedIds,
  labelsEnabled = true,
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
  canvasserFocusedGeofenceId?: string
  /** Geofence ids where every in-area address is canvassed (total > 0). */
  geofenceAllCanvassedIds?: ReadonlySet<string>
  labelsEnabled?: boolean
  onCreated: (geometry: GeoJSON.Polygon) => void
  onEdited: (updates: Array<{ id: string; geometry: GeoJSON.Polygon }>) => void
  onDeleted: (ids: string[]) => void | Promise<boolean>
  onSelect: (id: string) => void
}) {
  const map = useMap()
  const featureGroupRef = useRef<L.FeatureGroup | null>(null)
  const layersByIdRef = useRef<Map<string, GeofencePolygonLayer>>(new Map())
  const drawControlRef = useRef<L.Control.Draw | null>(null)
  const blockGeofenceClearOnMapClickRef = useRef(false)
  /** Canvasser: fence click bubbles to map; skip one map.clear so onSelect('') does not undo fence focus. */
  const skipNextBubbledMapClearRef = useRef(false)
  const onSelectRef = useRef(onSelect)
  const onCreatedRef = useRef(onCreated)
  const onEditedRef = useRef(onEdited)
  const onDeletedRef = useRef(onDeleted)
  const enabledRef = useRef(enabled)
  const allowGeofenceSelectRef = useRef(allowGeofenceSelect)
  const geofenceAllCanvassedIdsRef = useRef(geofenceAllCanvassedIds)
  geofenceAllCanvassedIdsRef.current = geofenceAllCanvassedIds

  const styleContextForFence = (
    fenceId: string,
    isMine: boolean,
  ): GeofenceStyleContext => ({
    fenceId,
    allowGeofenceSelect,
    enabled,
    assignedGeofenceIdList,
    canvasserFocusedGeofenceId,
    isMine,
    allCanvassed: geofenceAllCanvassedIdsRef.current?.has(fenceId) ?? false,
  })

  useEffect(() => {
    onSelectRef.current = onSelect
    onCreatedRef.current = onCreated
    onEditedRef.current = onEdited
    onDeletedRef.current = onDeleted
    enabledRef.current = enabled
    allowGeofenceSelectRef.current = allowGeofenceSelect
  })

  const syncFenceClick = (layer: GeofencePolygonLayer, fenceId: string) => {
    layer.off('click')
    if (!allowGeofenceSelectRef.current) return
    layer.on('click', (e: L.LeafletMouseEvent) => {
      if (enabledRef.current) {
        L.DomEvent.stopPropagation(e)
      } else {
        skipNextBubbledMapClearRef.current = true
        window.requestAnimationFrame(() => {
          skipNextBubbledMapClearRef.current = false
        })
      }
      onSelectRef.current(fenceId)
    })
  }

  useEffect(() => {
    if (!featureGroupRef.current) {
      featureGroupRef.current = new L.FeatureGroup()
      map.addLayer(featureGroupRef.current)
    }

    const group = featureGroupRef.current
    const layersById = layersByIdRef.current
    const assignedSet = new Set(assignedGeofenceIdList)
    const nextIds = new Set(geofences.map((fence) => fence.id))

    for (const [id, layer] of layersById) {
      if (nextIds.has(id)) continue
      group.removeLayer(layer)
      layersById.delete(id)
    }

    for (const fence of geofences) {
      const structureKey = fenceStructureKey(fence)
      let layer = layersById.get(fence.id)

      if (!layer) {
        layer = L.polygon(fenceLatLngs(fence), {
          pane: 'geofencePane',
        }) as GeofencePolygonLayer
        layer.geofenceId = fence.id
        layer.geofenceStructureKey = structureKey
        layer.setStyle(getGeofencePathOptions(styleContextForFence(fence.id, assignedSet.has(fence.id))))
        setFenceTooltip(layer, fence)
        syncFenceClick(layer, fence.id)
        group.addLayer(layer)
        layersById.set(fence.id, layer)
        continue
      }

      if (layer.geofenceStructureKey !== structureKey) {
        layer.setLatLngs(fenceLatLngs(fence))
        layer.geofenceStructureKey = structureKey
        setFenceTooltip(layer, fence)
      }

      syncFenceClick(layer, fence.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- structure sync on geometry/name/id changes
  }, [map, geofences, allowGeofenceSelect, enabled, geofenceAllCanvassedIds])

  useEffect(() => {
    const assignedSet = new Set(assignedGeofenceIdList)
    const layersById = layersByIdRef.current

    for (const fence of geofences) {
      const layer = layersById.get(fence.id)
      if (!layer) continue
      layer.setStyle(getGeofencePathOptions(styleContextForFence(fence.id, assignedSet.has(fence.id))))
    }
  }, [
    geofences,
    assignedGeofenceIdList,
    allowGeofenceSelect,
    enabled,
    canvasserFocusedGeofenceId,
    geofenceAllCanvassedIds,
  ])

  useEffect(() => {
    const syncLabelVisibility = () => {
      const show = labelsEnabled && map.getZoom() >= GEOFENCE_LABEL_MIN_ZOOM
      for (const layer of layersByIdRef.current.values()) {
        layer.getTooltip()?.setOpacity(show ? 1 : 0)
      }
    }
    const hideLabelsDuringZoom = () => {
      for (const layer of layersByIdRef.current.values()) {
        layer.getTooltip()?.setOpacity(0)
      }
    }
    map.on('zoomstart', hideLabelsDuringZoom)
    map.on('zoomend', syncLabelVisibility)
    map.on('moveend', syncLabelVisibility)
    syncLabelVisibility()
    return () => {
      map.off('zoomstart', hideLabelsDuringZoom)
      map.off('zoomend', syncLabelVisibility)
      map.off('moveend', syncLabelVisibility)
    }
  }, [map, geofences, labelsEnabled])

  useEffect(() => {
    const block = () => {
      blockGeofenceClearOnMapClickRef.current = true
    }
    const unblock = () => {
      blockGeofenceClearOnMapClickRef.current = false
    }
    map.on(L.Draw.Event.DRAWSTART, block)
    map.on(L.Draw.Event.DRAWSTOP, unblock)
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
      if (blockGeofenceClearOnMapClickRef.current) return
      if (skipNextBubbledMapClearRef.current) return
      onSelectRef.current('')
    }
    map.on('click', onMapClick)
    return () => {
      map.off('click', onMapClick)
    }
  }, [map, allowGeofenceSelect])

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
      if (!enabledRef.current) return
      blockGeofenceClearOnMapClickRef.current = true
      const layer = event.layer as L.Polygon
      const geometry = (layer.toGeoJSON() as GeoJSON.Feature<GeoJSON.Polygon>).geometry
      void Promise.resolve(onCreatedRef.current(geometry)).finally(() => {
        window.requestAnimationFrame(() => {
          blockGeofenceClearOnMapClickRef.current = false
        })
      })
    }
    const handleEdited = (event: L.DrawEvents.Edited) => {
      if (!enabledRef.current) return
      const updates: Array<{ id: string; geometry: GeoJSON.Polygon }> = []
      event.layers.eachLayer((layer) => {
        const polygon = layer as GeofencePolygonLayer
        if (!polygon.geofenceId) return
        const geometry = (polygon.toGeoJSON() as GeoJSON.Feature<GeoJSON.Polygon>).geometry
        updates.push({ id: polygon.geofenceId, geometry })
      })
      if (updates.length > 0) onEditedRef.current(updates)
    }
    const handleDeleted = (event: L.DrawEvents.Deleted) => {
      if (!enabledRef.current) return
      const ids: string[] = []
      event.layers.eachLayer((layer) => {
        const polygon = layer as GeofencePolygonLayer
        if (polygon.geofenceId) ids.push(polygon.geofenceId)
      })
      if (ids.length > 0) void onDeletedRef.current(ids)
    }

    map.on(L.Draw.Event.CREATED, handleCreated)
    map.on(L.Draw.Event.EDITED, handleEdited)
    map.on(L.Draw.Event.DELETED, handleDeleted)
    return () => {
      map.off(L.Draw.Event.CREATED, handleCreated)
      map.off(L.Draw.Event.EDITED, handleEdited)
      map.off(L.Draw.Event.DELETED, handleDeleted)
    }
  }, [map])

  return null
}

/** Admin-only: stacks under Leaflet zoom / draw tools so it never covers the geofence icon. */
export function HotZoneEditModeControl({
  editMode,
  onToggle,
}: {
  editMode: boolean
  onToggle: () => void
}) {
  const map = useMap()
  const onToggleRef = useRef(onToggle)
  onToggleRef.current = onToggle

  useEffect(() => {
    const Control = L.Control.extend({
      onAdd() {
        const container = L.DomUtil.create('div', 'leaflet-bar hot-zone-edit-leaflet-control')
        const button = L.DomUtil.create('a', '', container) as HTMLAnchorElement
        button.href = '#'
        button.role = 'button'
        button.textContent = 'HZ'
        button.title = editMode ? 'Exit Hot Zone edit mode' : 'Edit Hot Zone'
        button.setAttribute(
          'aria-label',
          editMode ? 'Exit Hot Zone edit mode' : 'Edit Hot Zone',
        )
        button.setAttribute('aria-pressed', editMode ? 'true' : 'false')
        if (editMode) {
          L.DomUtil.addClass(button, 'is-active')
        }
        L.DomEvent.disableClickPropagation(container)
        L.DomEvent.on(button, 'click', (e) => {
          L.DomEvent.preventDefault(e)
          onToggleRef.current()
        })
        return container
      },
    })
    const control = new Control({ position: 'topleft' })
    map.addControl(control)
    return () => {
      map.removeControl(control)
    }
  }, [map, editMode])

  return null
}

const HOT_ZONE_PATH_OPTIONS: L.PathOptions = {
  color: '#b91c1c',
  weight: 3,
  fillColor: '#ef4444',
  fillOpacity: 0.28,
  className: 'hot-zone-polygon',
}

type HotZonePolygonLayer = L.Polygon & {
  hotZoneId?: string
  hotZoneStructureKey?: string
}

function hotZoneLatLngs(zone: HotZoneRow): L.LatLngExpression[] {
  return zone.geometry.coordinates[0].map(([lng, lat]) => [lat, lng] as [number, number])
}

function hotZoneStructureKey(zone: HotZoneRow): string {
  const ring = zone.geometry.coordinates[0] ?? []
  let coordChecksum = 0
  for (const pt of ring) {
    coordChecksum += (pt[0] ?? 0) + (pt[1] ?? 0)
  }
  return `${zone.id}:${ring.length}:${coordChecksum.toFixed(6)}:${zone.name}`
}

/**
 * Display-only Hot Zone in normal mode (interactive: false).
 * In editMode: drawable if missing, editable/deletable if present; use instead of geofence draw.
 */
export function HotZoneDrawManager({
  hotZone,
  visible,
  editMode,
  onCreated,
  onEdited,
  onDeleted,
}: {
  hotZone: HotZoneRow | null
  /** Show polygon when true (or always while editMode). */
  visible: boolean
  editMode: boolean
  onCreated: (geometry: GeoJSON.Polygon) => void | Promise<void>
  onEdited: (id: string, geometry: GeoJSON.Polygon) => void | Promise<void>
  onDeleted: (id: string) => void | Promise<void>
}) {
  const map = useMap()
  const featureGroupRef = useRef<L.FeatureGroup | null>(null)
  const layerRef = useRef<HotZonePolygonLayer | null>(null)
  const drawControlRef = useRef<L.Control.Draw | null>(null)
  const onCreatedRef = useRef(onCreated)
  const onEditedRef = useRef(onEdited)
  const onDeletedRef = useRef(onDeleted)

  useEffect(() => {
    onCreatedRef.current = onCreated
    onEditedRef.current = onEdited
    onDeletedRef.current = onDeleted
  })

  useEffect(() => {
    if (!featureGroupRef.current) {
      featureGroupRef.current = new L.FeatureGroup()
      map.addLayer(featureGroupRef.current)
    }
    const group = featureGroupRef.current
    const show = editMode || visible

    if (!hotZone || !show) {
      if (layerRef.current) {
        group.removeLayer(layerRef.current)
        layerRef.current = null
      }
      return
    }

    const structureKey = hotZoneStructureKey(hotZone)
    const existing = layerRef.current
    const needsInteractiveChange = existing && existing.options.interactive !== editMode

    if (!existing || needsInteractiveChange) {
      if (existing) {
        group.removeLayer(existing)
        layerRef.current = null
      }
      const layer = L.polygon(hotZoneLatLngs(hotZone), {
        pane: 'hotZonePane',
        ...HOT_ZONE_PATH_OPTIONS,
        interactive: editMode,
      }) as HotZonePolygonLayer
      layer.hotZoneId = hotZone.id
      layer.hotZoneStructureKey = structureKey
      group.addLayer(layer)
      layerRef.current = layer
      return
    }

    if (existing.hotZoneStructureKey !== structureKey) {
      existing.setLatLngs(hotZoneLatLngs(hotZone))
      existing.hotZoneId = hotZone.id
      existing.hotZoneStructureKey = structureKey
    }
    existing.setStyle(HOT_ZONE_PATH_OPTIONS)
  }, [map, hotZone, visible, editMode])

  useEffect(() => {
    // Ensure a feature group exists before mounting draw tools (create-first path has no polygon yet).
    if (!featureGroupRef.current) {
      featureGroupRef.current = new L.FeatureGroup()
      map.addLayer(featureGroupRef.current)
    }
    const group = featureGroupRef.current

    const removeDrawControl = () => {
      if (drawControlRef.current) {
        map.removeControl(drawControlRef.current)
        drawControlRef.current = null
      }
    }

    if (!editMode) {
      removeDrawControl()
      return removeDrawControl
    }

    removeDrawControl()
    const hasZone = Boolean(hotZone)
    drawControlRef.current = new L.Control.Draw({
      draw: {
        polygon: hasZone ? false : {},
        rectangle: false,
        polyline: false,
        marker: false,
        circle: false,
        circlemarker: false,
      },
      ...(hasZone
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
  }, [map, editMode, hotZone])

  useEffect(() => {
    if (!editMode) return

    const handleCreated = (event: L.DrawEvents.Created) => {
      const layer = event.layer as L.Polygon
      const geometry = (layer.toGeoJSON() as GeoJSON.Feature<GeoJSON.Polygon>).geometry
      const group = featureGroupRef.current
      if (group) group.removeLayer(layer)
      void onCreatedRef.current(geometry)
    }
    const handleEdited = (event: L.DrawEvents.Edited) => {
      event.layers.eachLayer((layer) => {
        const polygon = layer as HotZonePolygonLayer
        if (!polygon.hotZoneId) return
        const geometry = (polygon.toGeoJSON() as GeoJSON.Feature<GeoJSON.Polygon>).geometry
        void onEditedRef.current(polygon.hotZoneId, geometry)
      })
    }
    const handleDeleted = (event: L.DrawEvents.Deleted) => {
      event.layers.eachLayer((layer) => {
        const polygon = layer as HotZonePolygonLayer
        if (polygon.hotZoneId) void onDeletedRef.current(polygon.hotZoneId)
      })
      layerRef.current = null
    }

    map.on(L.Draw.Event.CREATED, handleCreated)
    map.on(L.Draw.Event.EDITED, handleEdited)
    map.on(L.Draw.Event.DELETED, handleDeleted)
    return () => {
      map.off(L.Draw.Event.CREATED, handleCreated)
      map.off(L.Draw.Event.EDITED, handleEdited)
      map.off(L.Draw.Event.DELETED, handleDeleted)
    }
  }, [map, editMode])

  return null
}

export function GeofenceTrashIcon() {
  return (
    <svg className="geofence-trash-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

export function GeofenceChevronLeftIcon() {
  return (
    <svg
      className="geofence-chevron-left-svg"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

export function GeofencePencilIcon() {
  return (
    <svg
      className="geofence-pencil-svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

export function GeofenceMarkCanvassedIcon() {
  return (
    <svg className="geofence-mark-canvassed-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9" />
    </svg>
  )
}

export function MapHelpInfoIcon() {
  return (
    <svg className="map-help-info-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

export function PasswordEyeIcon({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M2 12c2.4-4 5.7-6 10-6s7.6 2 10 6c-2.4 4-5.7 6-10 6s-7.6-2-10-6Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      {!visible ? <path d="M4 20 20 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> : null}
    </svg>
  )
}
