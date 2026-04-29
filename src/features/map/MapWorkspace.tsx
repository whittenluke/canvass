import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet-draw'
import { useMap, useMapEvents } from 'react-leaflet'
import { VIEWPORT_LIMIT } from '../app/utils'
import type { GeofenceRow, ViewportBounds } from '../app/types'

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
    text = 'Address dots are hidden. Use "Show dots" to re-enable.'
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
      const layer = L.polygon(fence.geometry.coordinates[0].map(([lng, lat]) => [lat, lng] as [number, number]), {
        pane: 'geofencePane',
        color,
        weight,
        fillColor,
        fillOpacity,
      }) as L.Polygon & { geofenceId?: string }
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
      if (blockGeofenceClearOnMapClickRef.current) return
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
