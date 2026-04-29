import { useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { APP_ROLES, VIEWPORT_LIMIT } from '../app/utils'
import type { AddressRow, ViewportBounds } from '../app/types'

type UseViewportAddressesArgs = {
  sessionUserId?: string
  role: string
  viewport: ViewportBounds | null
  onSetAddresses: (rows: AddressRow[]) => void
  onSetHitViewportLimit: (value: boolean) => void
  onSetErrorMessage: (message: string) => void
}

export function useViewportAddresses({
  sessionUserId,
  role,
  viewport,
  onSetAddresses,
  onSetHitViewportLimit,
  onSetErrorMessage,
}: UseViewportAddressesArgs) {
  useEffect(() => {
    const fetchAddresses = async () => {
      if (!supabase || !sessionUserId || !APP_ROLES.has(role) || !viewport) {
        return
      }

      const centerLat = (viewport.south + viewport.north) / 2
      const centerLng = (viewport.west + viewport.east) / 2

      const { count: bboxCount, error: countError } = await supabase
        .from('addresses')
        .select('id', { count: 'exact', head: true })
        .gte('lat', viewport.south)
        .lte('lat', viewport.north)
        .gte('long', viewport.west)
        .lte('long', viewport.east)

      if (countError) {
        onSetErrorMessage(countError.message)
        onSetAddresses([])
        onSetHitViewportLimit(false)
        return
      }

      const matchedCount = bboxCount ?? 0

      const rpcResult = await supabase.rpc('addresses_in_viewport_by_proximity', {
        south: viewport.south,
        north: viewport.north,
        west: viewport.west,
        east: viewport.east,
        clat: centerLat,
        clong: centerLng,
        row_limit: VIEWPORT_LIMIT,
      })

      let rows: AddressRow[]
      if (rpcResult.error) {
        const { data, error } = await supabase
          .from('addresses')
          .select('id,full_address,lat,long,canvassed')
          .gte('lat', viewport.south)
          .lte('lat', viewport.north)
          .gte('long', viewport.west)
          .lte('long', viewport.east)
          .limit(VIEWPORT_LIMIT)
        if (error) {
          onSetErrorMessage(error.message)
          onSetAddresses([])
          onSetHitViewportLimit(false)
          return
        }
        rows = (data as AddressRow[]) ?? []
      } else {
        rows = (rpcResult.data as AddressRow[]) ?? []
      }

      onSetHitViewportLimit(role === 'admin' && matchedCount > rows.length)
      onSetAddresses(rows)
    }

    const timer = window.setTimeout(() => {
      void fetchAddresses()
    }, 220)
    return () => window.clearTimeout(timer)
  }, [sessionUserId, role, viewport, onSetAddresses, onSetErrorMessage, onSetHitViewportLimit])
}
