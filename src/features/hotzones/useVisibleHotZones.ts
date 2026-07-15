import { useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { APP_ROLES } from '../app/utils'
import type { HotZoneRow } from '../app/types'

type UseVisibleHotZonesArgs = {
  sessionUserId?: string
  role: string
  onSetActiveHotZone: (row: HotZoneRow | null) => void
  onSetHotZoneMessage?: (message: string) => void
}

export function useVisibleHotZones({
  sessionUserId,
  role,
  onSetActiveHotZone,
  onSetHotZoneMessage,
}: UseVisibleHotZonesArgs) {
  useEffect(() => {
    const fetchHotZones = async () => {
      if (!supabase || !sessionUserId || !APP_ROLES.has(role)) {
        onSetActiveHotZone(null)
        return
      }
      const { data, error } = await supabase.rpc('list_visible_hot_zones')
      if (error) {
        onSetHotZoneMessage?.(error.message)
        onSetActiveHotZone(null)
        return
      }
      const rows = (data as HotZoneRow[] | null) ?? []
      onSetActiveHotZone(rows[0] ?? null)
    }
    void fetchHotZones()
  }, [sessionUserId, role, onSetActiveHotZone, onSetHotZoneMessage])
}
