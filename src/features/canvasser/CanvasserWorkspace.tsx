import { useMemo, useState, type ReactNode } from 'react'
import { addressInAssignedGeofences, buildStreetGroups } from '../app/utils'
import type { AddressRow, GeofenceRow } from '../app/types'

export function CollapsibleStreetBlock({
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
  meta: ReactNode
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
        <span className="collapsible-street-summary-leading">
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

export function NearbyAddressSheet({
  members,
  addresses,
  role,
  geofences,
  assignedGeofenceIdSet,
  onClose,
  onToggleCanvassed,
  onToggleSignedPetition,
}: {
  /** Snapshot from when the cluster opened; merged with live viewport rows when toggling status. */
  members: AddressRow[]
  addresses: AddressRow[]
  role: string
  geofences: GeofenceRow[]
  assignedGeofenceIdSet: Set<string>
  onClose: () => void
  onToggleCanvassed: (row: AddressRow) => void | Promise<void>
  onToggleSignedPetition: (row: AddressRow) => void | Promise<void>
}) {
  const rows = useMemo(() => {
    const liveById = new Map(addresses.map((a) => [a.id, a]))
    return members.map((m) => liveById.get(m.id) ?? m)
  }, [members, addresses])
  const sheetStreetGroups = useMemo(() => buildStreetGroups(rows), [rows])

  return (
    <div className="nearby-sheet-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="nearby-sheet" role="dialog" aria-modal="true" aria-labelledby="nearby-sheet-title" onClick={(event) => event.stopPropagation()}>
        <div className="nearby-sheet-header">
          <h2 id="nearby-sheet-title">Addresses here</h2>
          <button type="button" className="nearby-sheet-close" aria-label="Close list" onClick={onClose}>×</button>
        </div>
        <p className="nearby-sheet-subtitle">{rows.length} at this spot, grouped by street. Mark each unit as you go.</p>
        <div className="nearby-sheet-streets">
          {sheetStreetGroups.map((group, streetIndex) => {
            const n = group.rows.length
            const c = group.rows.filter((a) => a.canvassed).length
            const p = group.rows.filter((a) => a.signed_petition).length
            return (
              <CollapsibleStreetBlock
                key={group.sortKey}
                blockClassName="nearby-sheet-street"
                defaultOpen={sheetStreetGroups.length <= 4 || streetIndex < 2}
                summaryClassName="nearby-sheet-street-summary"
                nameClassName="nearby-sheet-street-name"
                metaClassName="nearby-sheet-street-meta"
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
                <ul className="nearby-sheet-list">
                  {group.rows.map((address) => {
                    const canToggle =
                      role === 'admin' ||
                      (role === 'canvasser' && addressInAssignedGeofences(address, geofences, assignedGeofenceIdSet))
                    return (
                      <li key={address.id} className="nearby-sheet-row">
                        <div className="nearby-sheet-row-text">
                          <span className="nearby-sheet-address">{address.full_address}</span>
                          <span className={`nearby-sheet-pill ${address.canvassed ? 'done' : 'todo'}`}>
                            {address.canvassed ? 'Canvassed' : 'Not canvassed'}
                          </span>
                          <span className={`nearby-sheet-pill ${address.signed_petition ? 'petition-signed' : 'petition-open'}`}>
                            {address.signed_petition ? 'Petition signed' : 'Petition not signed'}
                          </span>
                        </div>
                        <div className="nearby-sheet-row-actions">
                          <button type="button" className="nearby-sheet-action" disabled={!canToggle} onClick={() => void onToggleCanvassed(address)}>
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
                          <button type="button" className="nearby-sheet-action" disabled={!canToggle} onClick={() => void onToggleSignedPetition(address)}>
                            {role === 'admin'
                              ? address.signed_petition
                                ? 'Clear petition'
                                : 'Signed petition'
                              : canToggle
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
      </div>
    </div>
  )
}
