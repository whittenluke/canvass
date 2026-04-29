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

export function NearbyAddressSheet({
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
    () => memberIds.map((id) => addresses.find((a) => a.id === id)).filter((a): a is AddressRow => a != null),
    [memberIds, addresses],
  )
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
                    (role === 'canvasser' && addressInAssignedGeofences(address, geofences, assignedGeofenceIdSet))
                  return (
                    <li key={address.id} className="nearby-sheet-row">
                      <div className="nearby-sheet-row-text">
                        <span className="nearby-sheet-address">{address.full_address}</span>
                        <span className={`nearby-sheet-pill ${address.canvassed ? 'done' : 'todo'}`}>
                          {address.canvassed ? 'Canvassed' : 'Not canvassed'}
                        </span>
                      </div>
                      <button type="button" className="nearby-sheet-action" disabled={!canToggle} onClick={() => void onToggle(address)}>
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
