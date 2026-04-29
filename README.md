# Canvass

Canvass is a role-based field canvassing app. Admins manage access and geofences, while canvassers work addresses in assigned areas.

## Tech stack

- Frontend: React + TypeScript + Vite (`src/App.tsx`)
- Map UI: Leaflet (`react-leaflet`, `leaflet-draw`)
- Backend/auth/data: Supabase (`src/lib/supabase.ts`)
- Hosting: Netlify (`netlify.toml`)

## Environment variables

Set these in your local environment:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_ALLOWED_LOGIN_EMAILS` (optional allowlist override)
- `VITE_AUTH_REDIRECT_URL` (optional auth redirect override)

## Supabase migrations and RPC coverage

The app relies on Supabase RPCs called from `src/App.tsx`. To prevent runtime failures in fresh environments, every RPC used by the app should be represented by SQL in `supabase/migrations`.

Run this check:

```bash
npm run check:rpc-coverage
```

What it does:

- Reads RPC calls in `src/App.tsx`
- Reads function definitions in `supabase/migrations/*.sql`
- Fails with a missing-function list when an app RPC is not migration-backed

Recommended workflow after running manual SQL in Supabase:

1. Add/create a migration file with the same function definitions.
2. Re-run `npm run check:rpc-coverage`.
3. Commit only when the check passes or you intentionally accept a temporary gap.

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## PWA assets

PWA and favicon assets are in `public/icons_and_manifest/icons/`.  
Manifest: `public/manifest.webmanifest`.
