import { useLayoutEffect } from 'react'
import { SupportDocsPage } from './SupportDocsPage'
import { useResolvedAppRole } from './useResolvedAppRole'

type SupportGuideRootProps = {
  requestedAudience: 'admins' | 'canvassers'
}

export function SupportGuideRoot({ requestedAudience }: SupportGuideRootProps) {
  const { role, loading, configError } = useResolvedAppRole()

  useLayoutEffect(() => {
    if (loading || configError) return
    if (!role) {
      window.location.replace('/')
      return
    }
    if (role === 'canvasser' && requestedAudience === 'admins') {
      window.location.replace('/support/canvassers')
    }
  }, [loading, role, configError, requestedAudience])

  if (configError) {
    return (
      <main className="support-docs-shell">
        <div className="support-docs-card">
          <p className="support-docs-error">{configError}</p>
          <a className="support-docs-back" href="/">
            Back to Canvass
          </a>
        </div>
      </main>
    )
  }

  if (loading) {
    return (
      <main className="support-docs-shell">
        <div className="support-docs-card support-docs-card--loading">
          <p className="support-docs-muted">Loading…</p>
        </div>
      </main>
    )
  }

  if (!role) {
    return null
  }

  if (role === 'canvasser' && requestedAudience === 'admins') {
    return null
  }

  return <SupportDocsPage audience={requestedAudience} viewerRole={role} />
}
