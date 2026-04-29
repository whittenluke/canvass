import { useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { APP_ROLES } from '../app/utils'
import type { GeofenceRow, GeofenceRpcRow } from '../app/types'

type UseVisibleGeofencesArgs = {
  sessionUserId?: string
  role: string
  onSetGeofences: (rows: GeofenceRow[]) => void
  onSetGeofenceMessage: (message: string) => void
}

export function useVisibleGeofences({
  sessionUserId,
  role,
  onSetGeofences,
  onSetGeofenceMessage,
}: UseVisibleGeofencesArgs) {
  useEffect(() => {
    const fetchGeofences = async () => {
      if (!supabase || !sessionUserId || !APP_ROLES.has(role)) return
      const { data: rpcData, error: rpcError } = await supabase.rpc('list_visible_geofences')
      if (!rpcError && rpcData !== null && rpcData !== undefined) {
        try {
          const parsed = typeof rpcData === 'string' ? JSON.parse(rpcData) : rpcData
          if (Array.isArray(parsed)) {
            onSetGeofences((parsed as GeofenceRpcRow[]).map((row) => ({ ...row })))
            return
          }
        } catch {
          // Fall through to legacy table read if RPC response is malformed.
        }
      }

      const rpcMissing = rpcError && /could not find|does not exist|schema cache/i.test(rpcError.message ?? '')
      if (rpcError && !rpcMissing) {
        onSetGeofenceMessage(rpcError.message)
        return
      }

      const { data, error } = await supabase
        .from('geofences')
        .select('id,name,geometry,assigned_email')
        .order('created_at', { ascending: true })
      if (error) {
        onSetGeofenceMessage(error.message)
        return
      }
      onSetGeofences((data as GeofenceRow[]) ?? [])
    }
    void fetchGeofences()
  }, [sessionUserId, role, onSetGeofences, onSetGeofenceMessage])
}
