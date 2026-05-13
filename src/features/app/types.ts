import type { supabase } from '../../lib/supabase'

export type AddressRow = {
  id: string
  full_address: string
  lat: number
  long: number
  canvassed: boolean
  signed_petition: boolean
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
  petitionSigned: number
  petitionRemaining: number
}

export type SupabaseClientNonNull = NonNullable<typeof supabase>

export type AdminMarkGeofenceResultRow = {
  updated_count: number
  already_canvassed: number
  total_count: number
}

export type AdminMarkGeofenceSignedPetitionResultRow = {
  updated_count: number
  already_signed: number
  total_count: number
}

export type AdminGeofenceProgressRow = {
  total_count: number
  canvassed_count: number
  remaining_count: number
  petition_signed_count: number
  petition_remaining_count: number
}

/** One row per geofence from `admin_list_geofence_progress` (or client fallback). */
export type AdminGeofenceListProgressRow = {
  geofence_id: string
  total_count: number
  canvassed_count: number
  remaining_count: number
  petition_signed_count: number
  petition_remaining_count: number
}

export type StreetAddressGroup = {
  sortKey: string
  heading: string
  rows: AddressRow[]
}

/** Row from `admin_dashboard_effort_summary` (denominator = distinct addresses in any geofence). */
export type AdminDashboardEffortSummaryRow = {
  total_addresses_in_areas: number
  canvassed_count: number
  petition_signed_count: number
}

/** Row from `admin_dashboard_contributor_leaderboard`. */
export type AdminDashboardContributorRow = {
  actor_id: string
  /** Display name from Admin Access (first + last); email only if names unset. */
  actor_name: string
  actor_role: string
  canvassed_marks: number
  petition_marks: number
}
