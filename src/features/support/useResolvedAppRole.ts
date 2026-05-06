import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { missingSupabaseConfig, supabase } from '../../lib/supabase'

export type ResolvedAppRole = 'admin' | 'canvasser' | null

export function useResolvedAppRole(): {
  role: ResolvedAppRole
  loading: boolean
  configError: string
} {
  const [role, setRole] = useState<ResolvedAppRole>(null)
  const [loading, setLoading] = useState(() => Boolean(supabase))

  useEffect(() => {
    if (!supabase) {
      return
    }

    const resolveFromSession = async (current: Session | null) => {
      setLoading(true)
      try {
        if (!current?.user) {
          setRole(null)
          return
        }

        await supabase.rpc('sync_profile_from_access')

        const normalizedEmail = current.user.email?.trim().toLowerCase()
        const userId = current.user.id

        const { data: byId, error: byIdError } = await supabase
          .from('profiles')
          .select('id,email,role')
          .eq('id', userId)
          .maybeSingle()

        if (byIdError) {
          setRole(null)
          return
        }

        let resolvedRole = byId?.role ?? ''

        if (!resolvedRole && normalizedEmail) {
          const { data: byEmail } = await supabase
            .from('profiles')
            .select('id,email,role')
            .eq('email', normalizedEmail)
            .maybeSingle()
          resolvedRole = byEmail?.role ?? ''
        }

        if (!resolvedRole && normalizedEmail) {
          const { data: accessByEmail } = await supabase
            .from('user_access')
            .select('role')
            .eq('email', normalizedEmail)
            .maybeSingle()
          resolvedRole = accessByEmail?.role ?? ''
        }

        const next: ResolvedAppRole =
          resolvedRole === 'admin' ? 'admin' : resolvedRole === 'canvasser' ? 'canvasser' : null
        setRole(next)
      } finally {
        setLoading(false)
      }
    }

    void supabase.auth.getSession().then(({ data }) => {
      void resolveFromSession(data.session)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void resolveFromSession(nextSession)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  return {
    role,
    loading,
    configError: missingSupabaseConfig,
  }
}
