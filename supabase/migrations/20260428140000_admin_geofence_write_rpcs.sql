-- Admin geofence writes bypass RLS on `geofences` (avoids stack depth from recursive policies).
-- `geofences.geometry` is stored as GeoJSON jsonb (same as PostgREST .insert({ geometry })).
-- If you use a PostGIS geometry column instead, enable extension postgis and use
-- ST_SetSRID(ST_GeomFromGeoJSON(p_geometry::text), 4326) for writes and ST_AsGeoJSON for reads.

CREATE OR REPLACE FUNCTION public.admin_insert_geofence(
  p_name text,
  p_geometry jsonb,
  p_assigned_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_email text;
  v_name text;
  v_email text;
  rec record;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email
  FROM auth.users u
  WHERE u.id = auth.uid();

  IF caller_email IS NULL OR caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email AND ua.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_name := coalesce(nullif(trim(p_name), ''), 'New geofence');
  v_email := nullif(lower(trim(coalesce(p_assigned_email, ''))), '');

  INSERT INTO public.geofences (name, geometry, assigned_email)
  VALUES (v_name, p_geometry, v_email)
  RETURNING id, name, geometry, assigned_email INTO rec;

  RETURN jsonb_build_object(
    'id', rec.id,
    'name', rec.name,
    'geometry', rec.geometry,
    'assigned_email', to_jsonb(rec.assigned_email)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_geofence_geometry(
  p_geofence_id uuid,
  p_geometry jsonb
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
    SELECT 1 FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email AND ua.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.geofences
  SET geometry = p_geometry
  WHERE id = p_geofence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'geofence not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_geofence_details(
  p_geofence_id uuid,
  p_name text,
  p_assigned_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_email text;
  v_name text;
  v_email text;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email
  FROM auth.users u
  WHERE u.id = auth.uid();

  IF caller_email IS NULL OR caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email AND ua.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_name := coalesce(nullif(trim(p_name), ''), 'Unnamed geofence');
  v_email := nullif(lower(trim(coalesce(p_assigned_email, ''))), '');

  UPDATE public.geofences
  SET name = v_name, assigned_email = v_email
  WHERE id = p_geofence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'geofence not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_geofences(p_ids uuid[])
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
    SELECT 1 FROM public.user_access ua
    WHERE lower(trim(ua.email)) = caller_email AND ua.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;

  DELETE FROM public.geofences WHERE id = ANY (p_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_insert_geofence(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_insert_geofence(text, jsonb, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_update_geofence_geometry(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_geofence_geometry(uuid, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_update_geofence_details(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_geofence_details(uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_delete_geofences(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_geofences(uuid[]) TO authenticated;
