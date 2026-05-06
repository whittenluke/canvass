import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import 'leaflet-draw/dist/leaflet.draw.css'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary'
import { SupportDocsPage } from './features/support/SupportDocsPage'
const pathname = typeof window === 'undefined' ? '/' : window.location.pathname.toLowerCase()
const rootView =
  pathname === '/support/admins' ? (
    <SupportDocsPage audience="admins" />
  ) : pathname === '/support/canvassers' ? (
    <SupportDocsPage audience="canvassers" />
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
