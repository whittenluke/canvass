-- Replace admin_dashboard_effort_summary: the previous version used EXISTS + st_contains
-- per (address, geofence) with no bbox prefilter, which times out at scale. This version
-- matches admin_list_geofence_progress: per-fence lateral with lat/long envelope filter
-- before st_contains, then DISTINCT address ids across fences.

CREATE OR REPLACE FUNCTION public.admin_dashboard_effort_summary()
RETURNS TABLE(
  total_addresses_in_areas bigint,
  canvassed_count bigint,
  petition_signed_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_caller_email text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT lower(trim(coalesce(u.email, '')))
  INTO v_caller_email
  FROM auth.users u
  WHERE u.id = v_uid;

  IF v_caller_email IS NULL OR v_caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_access ua
    WHERE lower(trim(ua.email)) = v_caller_email
      AND ua.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  WITH geofence_addresses AS (
    SELECT DISTINCT inside.id, inside.canvassed, inside.signed_petition
    FROM (
      SELECT g.geometry
      FROM public.geofences g
      WHERE g.geometry IS NOT NULL
    ) gf
    CROSS JOIN LATERAL (
      WITH poly AS (
        SELECT st_makevalid(st_setsrid(st_geomfromgeojson(gf.geometry::text), 4326)) AS geom
      ),
      env AS (
        SELECT
          p.geom,
          st_ymin(st_envelope(p.geom)) AS ymin,
          st_ymax(st_envelope(p.geom)) AS ymax,
          st_xmin(st_envelope(p.geom)) AS xmin,
          st_xmax(st_envelope(p.geom)) AS xmax
        FROM poly p
      )
      SELECT a.id, a.canvassed, a.signed_petition
      FROM public.addresses a
      CROSS JOIN env e
      WHERE a.lat >= e.ymin
        AND a.lat <= e.ymax
        AND (
          (e.xmin <= e.xmax AND a.long >= e.xmin AND a.long <= e.xmax)
          OR (e.xmin > e.xmax AND (a.long >= e.xmin OR a.long <= e.xmax))
        )
        AND st_contains(e.geom, st_setsrid(st_makepoint(a.long, a.lat), 4326))
    ) inside
  )
  SELECT
    count(*)::bigint AS total_addresses_in_areas,
    count(*) FILTER (WHERE geofence_addresses.canvassed)::bigint AS canvassed_count,
    count(*) FILTER (WHERE geofence_addresses.signed_petition)::bigint AS petition_signed_count
  FROM geofence_addresses;
END;
$$;
