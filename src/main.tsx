import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import 'leaflet-draw/dist/leaflet.draw.css'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary'
import { SupportGuideRoot } from './features/support/SupportGuideRoot'

const CHUNK_RECOVERY_KEY = 'canvass.chunk-recovery-attempted'

function recoverOnceFromChunkFailure(event?: Event) {
  event?.preventDefault()
  if (typeof window === 'undefined') return
  const alreadyRetried = window.sessionStorage.getItem(CHUNK_RECOVERY_KEY) === '1'
  if (alreadyRetried) return
  window.sessionStorage.setItem(CHUNK_RECOVERY_KEY, '1')
  window.location.reload()
}

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', recoverOnceFromChunkFailure as EventListener)
}

const pathname = typeof window === 'undefined' ? '/' : window.location.pathname.toLowerCase()
const rootView =
  pathname === '/support/admins' ? (
    <SupportGuideRoot requestedAudience="admins" />
  ) : pathname === '/support/canvassers' ? (
    <SupportGuideRoot requestedAudience="canvassers" />
  ) : (
    <App />
  )

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {rootView}
    </ErrorBoundary>
  </StrictMode>,
)

if (typeof window !== 'undefined') {
  window.sessionStorage.removeItem(CHUNK_RECOVERY_KEY)
}

if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => {
      void registration.unregister()
    })
  })
}

if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}
