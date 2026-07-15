-- Hot zones: separate from canvassing geofences. UI uses one active row for now.
CREATE TABLE IF NOT EXISTS public.hot_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'Hot Zone',
  geometry jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one active Hot Zone (allows inactive history / future multiples).
CREATE UNIQUE INDEX IF NOT EXISTS hot_zones_one_active
  ON public.hot_zones (is_active)
  WHERE is_active;

ALTER TABLE public.hot_zones ENABLE ROW LEVEL SECURITY;

-- Authenticated can read (admins + canvassers see on map).
DROP POLICY IF EXISTS hot_zones_select_authenticated ON public.hot_zones;
CREATE POLICY hot_zones_select_authenticated
  ON public.hot_zones FOR SELECT TO authenticated
  USING (true);

-- Writes only via SECURITY DEFINER RPCs (no direct insert/update/delete policies).

CREATE OR REPLACE FUNCTION public.list_visible_hot_zones()
RETURNS TABLE (
  id uuid,
  name text,
  geometry jsonb,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  RETURN QUERY
  SELECT h.id, h.name, h.geometry, h.is_active
  FROM public.hot_zones h
  WHERE h.is_active = true
  ORDER BY h.updated_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_active_hot_zone(
  p_name text,
  p_geometry jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_email text;
  v_name text;
  rec record;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email FROM auth.users u WHERE u.id = auth.uid();
  IF caller_email IS NULL OR caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email AND ua.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_name := coalesce(nullif(trim(p_name), ''), 'Hot Zone');

  UPDATE public.hot_zones
  SET name = v_name,
      geometry = p_geometry,
      updated_at = now()
  WHERE is_active
  RETURNING id, name, geometry, is_active INTO rec;

  IF NOT FOUND THEN
    INSERT INTO public.hot_zones (name, geometry, is_active)
    VALUES (v_name, p_geometry, true)
    RETURNING id, name, geometry, is_active INTO rec;
  END IF;

  RETURN jsonb_build_object(
    'id', rec.id,
    'name', rec.name,
    'geometry', rec.geometry,
    'is_active', rec.is_active
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_hot_zone_geometry(
  p_hot_zone_id uuid,
  p_geometry jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE caller_email text;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email FROM auth.users u WHERE u.id = auth.uid();
  IF caller_email IS NULL OR caller_email = '' THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email AND ua.role = 'admin'
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;

  UPDATE public.hot_zones
  SET geometry = p_geometry, updated_at = now()
  WHERE id = p_hot_zone_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_hot_zone_details(
  p_hot_zone_id uuid,
  p_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE caller_email text;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email FROM auth.users u WHERE u.id = auth.uid();
  IF caller_email IS NULL OR caller_email = '' THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email AND ua.role = 'admin'
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;

  UPDATE public.hot_zones
  SET name = coalesce(nullif(trim(p_name), ''), name),
      updated_at = now()
  WHERE id = p_hot_zone_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_hot_zone(p_hot_zone_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE caller_email text;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email FROM auth.users u WHERE u.id = auth.uid();
  IF caller_email IS NULL OR caller_email = '' THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email AND ua.role = 'admin'
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;

  DELETE FROM public.hot_zones WHERE id = p_hot_zone_id;
END;
$$;

REVOKE ALL ON FUNCTION public.list_visible_hot_zones() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_visible_hot_zones() TO authenticated;
REVOKE ALL ON FUNCTION public.admin_upsert_active_hot_zone(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_upsert_active_hot_zone(text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_update_hot_zone_geometry(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_hot_zone_geometry(uuid, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_update_hot_zone_details(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_hot_zone_details(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_hot_zone(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_hot_zone(uuid) TO authenticated;
