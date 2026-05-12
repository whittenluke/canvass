-- Append-only log of canvassed / signed_petition changes for fair metrics and admin dashboard.
-- Denominator for org-wide ratios: distinct addresses inside at least one geofence (overlap counts once).

CREATE TABLE IF NOT EXISTS public.address_status_events (
  id bigserial PRIMARY KEY,
  address_id uuid NOT NULL REFERENCES public.addresses (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  actor_role text NOT NULL DEFAULT 'unknown'
    CHECK (actor_role IN ('admin', 'canvasser', 'unknown')),
  canvassed_before boolean NOT NULL,
  canvassed_after boolean NOT NULL,
  signed_petition_before boolean NOT NULL,
  signed_petition_after boolean NOT NULL
);

COMMENT ON TABLE public.address_status_events IS
  'Append-only audit: each row records one UPDATE to addresses.canvassed and/or signed_petition.';

CREATE INDEX IF NOT EXISTS address_status_events_occurred_at_idx
  ON public.address_status_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS address_status_events_actor_id_idx
  ON public.address_status_events (actor_id);

CREATE INDEX IF NOT EXISTS address_status_events_address_id_idx
  ON public.address_status_events (address_id);

ALTER TABLE public.address_status_events ENABLE ROW LEVEL SECURITY;

-- No policies for SELECT/INSERT for authenticated: reads go through SECURITY DEFINER RPCs only.
-- Trigger runs as table owner and bypasses RLS for INSERT.

CREATE OR REPLACE FUNCTION public.log_address_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text := 'unknown';
BEGIN
  IF OLD.canvassed IS NOT DISTINCT FROM NEW.canvassed
     AND OLD.signed_petition IS NOT DISTINCT FROM NEW.signed_petition THEN
    RETURN NEW;
  END IF;

  IF v_uid IS NOT NULL THEN
    SELECT CASE
      WHEN ua.role = 'admin' THEN 'admin'
      WHEN ua.role = 'canvasser' THEN 'canvasser'
      ELSE 'unknown'
    END
    INTO v_role
    FROM auth.users u
    LEFT JOIN public.user_access ua
      ON lower(trim(ua.email)) = lower(trim(coalesce(u.email, '')))
    WHERE u.id = v_uid;
    IF v_role IS NULL THEN
      v_role := 'unknown';
    END IF;
  END IF;

  INSERT INTO public.address_status_events (
    address_id,
    actor_id,
    actor_role,
    canvassed_before,
    canvassed_after,
    signed_petition_before,
    signed_petition_after
  )
  VALUES (
    NEW.id,
    v_uid,
    v_role,
    OLD.canvassed,
    NEW.canvassed,
    OLD.signed_petition,
    NEW.signed_petition
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS addresses_log_status_change ON public.addresses;

CREATE TRIGGER addresses_log_status_change
  AFTER UPDATE OF canvassed, signed_petition ON public.addresses
  FOR EACH ROW
  WHEN (
    OLD.canvassed IS DISTINCT FROM NEW.canvassed
    OR OLD.signed_petition IS DISTINCT FROM NEW.signed_petition
  )
  EXECUTE PROCEDURE public.log_address_status_change();

-- ---------------------------------------------------------------------------
-- Admin dashboard: org-wide counts (denominator = distinct addresses in any geofence)
-- ---------------------------------------------------------------------------

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

REVOKE ALL ON FUNCTION public.admin_dashboard_effort_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_effort_summary() TO authenticated;

-- ---------------------------------------------------------------------------
-- Leaderboard: credits = transitions to true (does not subtract clears in v1)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_dashboard_contributor_leaderboard(
  p_since timestamptz DEFAULT NULL
)
RETURNS TABLE(
  actor_id uuid,
  actor_email text,
  actor_role text,
  canvassed_marks bigint,
  petition_marks bigint
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
  SELECT
    e.actor_id,
    lower(trim(coalesce(au.email, ''))) AS actor_email,
    e.actor_role,
    count(*) FILTER (
      WHERE e.canvassed_before IS DISTINCT FROM e.canvassed_after
        AND e.canvassed_after = true
    )::bigint AS canvassed_marks,
    count(*) FILTER (
      WHERE e.signed_petition_before IS DISTINCT FROM e.signed_petition_after
        AND e.signed_petition_after = true
    )::bigint AS petition_marks
  FROM public.address_status_events e
  LEFT JOIN auth.users au ON au.id = e.actor_id
  WHERE e.actor_id IS NOT NULL
    AND (p_since IS NULL OR e.occurred_at >= p_since)
  GROUP BY e.actor_id, lower(trim(coalesce(au.email, ''))), e.actor_role
  ORDER BY
    (count(*) FILTER (
      WHERE e.canvassed_before IS DISTINCT FROM e.canvassed_after
        AND e.canvassed_after = true
    )
    + count(*) FILTER (
      WHERE e.signed_petition_before IS DISTINCT FROM e.signed_petition_after
        AND e.signed_petition_after = true
    )) DESC,
    lower(trim(coalesce(au.email, ''))) ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_dashboard_contributor_leaderboard(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_contributor_leaderboard(timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin single-address RPCs: record updated_by / updated_at (secondary to event log)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_address_canvassed(
  p_address_id uuid,
  p_canvassed boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_email text;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email
  FROM auth.users u
  WHERE u.id = auth.uid();

  IF caller_email IS NULL OR caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email
      AND ua.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.addresses
  SET
    canvassed = p_canvassed,
    updated_at = now(),
    updated_by = auth.uid()
  WHERE id = p_address_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'address not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_address_signed_petition(
  p_address_id uuid,
  p_signed boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_email text;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email
  FROM auth.users u
  WHERE u.id = auth.uid();

  IF caller_email IS NULL OR caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email
      AND ua.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.addresses
  SET
    signed_petition = p_signed,
    updated_at = now(),
    updated_by = auth.uid()
  WHERE id = p_address_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'address not found';
  END IF;
END;
$$;
