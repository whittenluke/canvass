import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polygon,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import type { AddressRow, GeofenceRow, ViewportBounds } from '../app/types'
import {
  ADDRESS_CLUSTER_CROSS_GAP_METERS,
  ADDRESS_CLUSTER_MERGE_METERS,
  ADDRESS_EXACT_POINT_CLUSTER_MIN_ZOOM,
  ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM,
  adminAddressHitRadiusPx,
  clusterAddressesByExactPoint,
  clusterAddressesByProximity,
  clusterAddressesByViewportGrid,
  clusterBadgeIconDimensions,
  clusterHitRadiusPx,
  mergeClustersByCrossGap,
  sortClustersSinglesFirst,
} from '../app/utils'
import { NearbyAddressSheet } from '../canvasser/CanvasserWorkspace'

const BOUNDARY_STYLE: L.PathOptions = {
  color: '#b91c1c',
  weight: 3,
  fillColor: '#ef4444',
  fillOpacity: 0.22,
  interactive: false,
}

const BUFFER_STYLE: L.PathOptions = {
  color: '#991b1b',
  weight: 2,
  fillColor: '#f87171',
  fillOpacity: 0.18,
  interactive: false,
  dashArray: '6 4',
}

type ClusterBadgeStyle = 'todo' | 'canvassed' | 'petition'

const clusterCountIconCache = new Map<string, L.DivIcon>()

function createClusterCountIcon(count: number, badgeStyle: ClusterBadgeStyle): L.DivIcon {
  const badgeClass =
    badgeStyle === 'petition'
      ? 'address-cluster-hit__badge address-cluster-hit__badge--all-petition'
      : badgeStyle === 'canvassed'
        ? 'address-cluster-hit__badge address-cluster-hit__badge--all-canvassed'
        : 'address-cluster-hit__badge'
  const { width, height } = clusterBadgeIconDimensions(count)
  return L.divIcon({
    className: 'address-cluster-leaflet-marker',
    html: `<span class="${badgeClass}" aria-hidden="true">${count}</span>`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height / 2],
  })
}

function getClusterCountIcon(count: number, badgeStyle: ClusterBadgeStyle): L.DivIcon {
  const key = `${count}|${badgeStyle}`
  let icon = clusterCountIconCache.get(key)
  if (!icon) {
    icon = createClusterCountIcon(count, badgeStyle)
    clusterCountIconCache.set(key, icon)
  }
  return icon
}

function FitToPolygons({
  boundary,
  bufferGeometry,
}: {
  boundary: GeoJSON.Polygon
  bufferGeometry: GeoJSON.Polygon | null
}) {
  const map = useMap()
  useEffect(() => {
    const bounds = L.latLngBounds([])
    const addRing = (ring: GeoJSON.Position[]) => {
      for (const [lng, lat] of ring) {
        bounds.extend([lat, lng])
      }
    }
    const bRing = boundary.coordinates[0]
    if (bRing) addRing(bRing)
    const bufRing = bufferGeometry?.coordinates[0]
    if (bufRing) addRing(bufRing)
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 })
    }
  }, [map, boundary, bufferGeometry])
  return null
}

function ViewportTracker({ onChange }: { onChange: (vp: ViewportBounds) => void }) {
  const map = useMap()
  const publish = () => {
    const b = map.getBounds()
    onChange({
      south: b.getSouth(),
      north: b.getNorth(),
      west: b.getWest(),
      east: b.getEast(),
      zoom: map.getZoom(),
    })
  }
  useEffect(() => {
    publish()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial sync only; events handle updates
  }, [map])
  useMapEvents({
    moveend: publish,
    zoomend: publish,
  })
  return null
}

function ringToLatLngs(geometry: GeoJSON.Polygon): L.LatLngExpression[] {
  return (geometry.coordinates[0] ?? []).map(([lng, lat]) => [lat, lng] as [number, number])
}

function addressPathOptions(address: AddressRow, isOpen: boolean): L.PathOptions {
  const weight = (address.signed_petition || address.canvassed ? 3 : 2) + (isOpen ? 1 : 0)
  if (address.signed_petition) {
    return {
      color: '#b45309',
      fillColor: '#f97316',
      fillOpacity: 1,
      weight,
      className: isOpen
        ? 'address-dot-visual address-dot-visual--open address-dot-visual--open-petition'
        : 'address-dot-visual',
    }
  }
  if (address.canvassed) {
    return {
      color: '#ffffff',
      fillColor: '#2563eb',
      fillOpacity: 1,
      weight,
      className: isOpen ? 'address-dot-visual address-dot-visual--open' : 'address-dot-visual',
    }
  }
  return {
    color: '#7f1d1d',
    fillColor: '#dc2626',
    fillOpacity: 1,
    weight,
    className: isOpen ? 'address-dot-visual address-dot-visual--open' : 'address-dot-visual',
  }
}

export function HotZoneAddressesMap({
  boundary,
  bufferGeometry,
  outsideAddresses,
  highlightedAddresses,
  onToggleCanvassed,
  onToggleSignedPetition,
}: {
  boundary: GeoJSON.Polygon
  bufferGeometry: GeoJSON.Polygon | null
  outsideAddresses: AddressRow[]
  highlightedAddresses: AddressRow[]
  onToggleCanvassed: (address: AddressRow) => void
  onToggleSignedPetition: (address: AddressRow) => void
}) {
  const [openPopupId, setOpenPopupId] = useState<string | null>(null)
  const [outsideDotsEnabled, setOutsideDotsEnabled] = useState(true)
  const [mapViewport, setMapViewport] = useState<ViewportBounds | null>(null)
  const [clusterSheetMembers, setClusterSheetMembers] = useState<AddressRow[] | null>(null)

  const center = useMemo<[number, number]>(() => {
    const ring = boundary.coordinates[0] ?? []
    if (ring.length === 0) return [36.2413, -80.2937]
    let lat = 0
    let lng = 0
    for (const [x, y] of ring) {
      lng += x
      lat += y
    }
    return [lat / ring.length, lng / ring.length]
  }, [boundary])

  const mapAddresses = useMemo(() => {
    const byId = new Map<string, AddressRow>()
    if (outsideDotsEnabled) {
      for (const row of outsideAddresses) byId.set(row.id, row)
    }
    for (const row of highlightedAddresses) byId.set(row.id, row)
    return Array.from(byId.values())
  }, [outsideAddresses, highlightedAddresses, outsideDotsEnabled])

  const addressClusters = useMemo(() => {
    if (mapAddresses.length === 0) return []
    const zoom = mapViewport?.zoom ?? 14

    if (zoom >= ADDRESS_EXACT_POINT_CLUSTER_MIN_ZOOM) {
      return sortClustersSinglesFirst(clusterAddressesByExactPoint(mapAddresses))
    }

    if (zoom >= ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM || !mapViewport) {
      const linked = clusterAddressesByProximity(mapAddresses, ADDRESS_CLUSTER_MERGE_METERS)
      const merged = mergeClustersByCrossGap(linked, ADDRESS_CLUSTER_CROSS_GAP_METERS)
      return sortClustersSinglesFirst(merged)
    }

    const cellPixels = zoom <= 14 ? 72 : zoom <= 15 ? 56 : 48
    return sortClustersSinglesFirst(
      clusterAddressesByViewportGrid(mapAddresses, mapViewport, cellPixels),
    )
  }, [mapAddresses, mapViewport])

  const zoom = mapViewport?.zoom ?? 14
  const isCloseZoom = zoom >= ADMIN_PROXIMITY_CLUSTER_MIN_ZOOM
  const emptyGeofences = useMemo<GeofenceRow[]>(() => [], [])
  const emptyAssignedSet = useMemo(() => new Set<string>(), [])

  return (
    <div className="hotzone-addresses-map-wrap">
      <div className="hotzone-addresses-map-controls">
        <button
          type="button"
          className={`map-icon-control${outsideDotsEnabled ? '' : ' map-icon-control--off'}`}
          title={
            outsideDotsEnabled
              ? 'Hide dots outside buffer'
              : 'Show dots outside buffer'
          }
          aria-label={
            outsideDotsEnabled
              ? 'Hide dots outside buffer'
              : 'Show dots outside buffer'
          }
          aria-pressed={outsideDotsEnabled}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setOutsideDotsEnabled((current) => !current)}
        >
          {outsideDotsEnabled ? '◉' : '○'}
        </button>
      </div>
      <MapContainer
        center={center}
        zoom={14}
        scrollWheelZoom
        className="hotzone-addresses-map"
        attributionControl={false}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <ViewportTracker onChange={setMapViewport} />
        <FitToPolygons boundary={boundary} bufferGeometry={bufferGeometry} />
        {bufferGeometry ? (
          <Polygon positions={ringToLatLngs(bufferGeometry)} pathOptions={BUFFER_STYLE} />
        ) : null}
        <Polygon positions={ringToLatLngs(boundary)} pathOptions={BOUNDARY_STYLE} />
        {addressClusters.map((members) => {
          const clusterKey = members
            .map((m) => m.id)
            .sort()
            .join('|')

          if (members.length === 1) {
            const address = members[0]
            const isPopupOpen = openPopupId === address.id
            const hasPetition = address.signed_petition
            const hasCanvassed = address.canvassed
            const baseRadius = hasPetition || hasCanvassed ? 8 : 7
            const visualRadius = baseRadius + (isPopupOpen ? 4 : 0)
            const visualPathOptions = addressPathOptions(address, isPopupOpen)
            const popupOpenHandlers = {
              click: (e: L.LeafletMouseEvent) => {
                L.DomEvent.stopPropagation(e)
              },
              popupopen: () => setOpenPopupId(address.id),
              popupclose: () =>
                setOpenPopupId((prev) => (prev === address.id ? null : prev)),
            }
            const popupContent = (
              <>
                <p className="popup-address">{address.full_address}</p>
                <div className="popup-address-actions">
                  <button
                    type="button"
                    className="status-button"
                    onClick={() => onToggleCanvassed(address)}
                  >
                    {address.canvassed ? 'Mark uncanvassed' : 'Mark canvassed'}
                  </button>
                  <button
                    type="button"
                    className="status-button"
                    onClick={() => onToggleSignedPetition(address)}
                  >
                    {address.signed_petition ? 'Clear petition' : 'Signed petition'}
                  </button>
                </div>
              </>
            )
            return (
              <Fragment key={address.id}>
                {hasPetition ? (
                  <CircleMarker
                    center={[address.lat, address.long]}
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
                    center={[address.lat, address.long]}
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
                <CircleMarker
                  center={[address.lat, address.long]}
                  radius={visualRadius}
                  interactive={false}
                  pathOptions={visualPathOptions}
                />
                <CircleMarker
                  center={[address.lat, address.long]}
                  radius={adminAddressHitRadiusPx(zoom, visualRadius)}
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
              </Fragment>
            )
          }

          const centroidLat = members.reduce((sum, m) => sum + m.lat, 0) / members.length
          const centroidLng = members.reduce((sum, m) => sum + m.long, 0) / members.length
          const allPetitionSigned =
            members.length > 0 && members.every((m) => m.signed_petition)
          const allCanvassed = members.length > 0 && members.every((m) => m.canvassed)
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
                  center={[centroidLat, centroidLng]}
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
                  center={[centroidLat, centroidLng]}
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
                interactive={false}
                icon={getClusterCountIcon(members.length, clusterBadgeStyle)}
              />
              <CircleMarker
                center={[centroidLat, centroidLng]}
                radius={clusterHitRadiusPx(members.length, zoom)}
                pathOptions={{
                  className: 'address-marker-hit address-cluster-marker-hit',
                  color: '#000000',
                  opacity: 0,
                  fillColor: '#000000',
                  fillOpacity: 0.001,
                  weight: 0,
                }}
                eventHandlers={{
                  click: (e) => {
                    L.DomEvent.stopPropagation(e)
                    setClusterSheetMembers(sortedMembers)
                  },
                }}
              />
            </Fragment>
          )
        })}
      </MapContainer>
      {clusterSheetMembers ? (
        <NearbyAddressSheet
          members={clusterSheetMembers}
          addresses={mapAddresses}
          role="admin"
          geofences={emptyGeofences}
          assignedGeofenceIdSet={emptyAssignedSet}
          onClose={() => setClusterSheetMembers(null)}
          onToggleCanvassed={onToggleCanvassed}
          onToggleSignedPetition={onToggleSignedPetition}
        />
      ) : null}
    </div>
  )
}
