import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const missingSupabaseConfig =
  !supabaseUrl || !supabasePublishableKey
    ? 'Missing Supabase configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.'
    : ''

export const supabase = missingSupabaseConfig
  ? null
  : createClient(supabaseUrl, supabasePublishableKey)
