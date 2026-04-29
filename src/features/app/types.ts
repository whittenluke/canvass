import type { supabase } from '../../lib/supabase'

export type AddressRow = {
  id: string
  full_address: string
  lat: number
  long: number
  canvassed: boolean
}

export type AccessRow = {
  email: string
  role: 'admin' | 'canvasser'
  status: 'pending' | 'active'
  first_name: string | null
  last_name: string | null
}

export type ViewportBounds = {
  south: number
  west: number
  north: number
  east: number
  zoom: number
}

export type GeofenceRow = {
  id: string
  name: string
  geometry: GeoJSON.Polygon
  assigned_email: string | null
}

export type GeofenceRpcRow = {
  id: string
  name: string
  geometry: GeoJSON.Polygon
  assigned_email: string | null
}

export type GeofenceProgress = {
  total: number
  canvassed: number
  remaining: number
}

export type SupabaseClientNonNull = NonNullable<typeof supabase>

export type AdminMarkGeofenceResultRow = {
  updated_count: number
  already_canvassed: number
  total_count: number
}

export type AdminGeofenceProgressRow = {
  total_count: number
  canvassed_count: number
  remaining_count: number
}

export type StreetAddressGroup = {
  sortKey: string
  heading: string
  rows: AddressRow[]
}
