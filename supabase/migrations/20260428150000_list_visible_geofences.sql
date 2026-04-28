-- Unified geofence reader that bypasses recursive RLS/policy stacks.
-- Returns all geofences for admins, and only assigned geofences for canvassers.

CREATE OR REPLACE FUNCTION public.list_visible_geofences()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_email text;
  caller_role text;
BEGIN
  SELECT lower(trim(coalesce(u.email, '')))
  INTO caller_email
  FROM auth.users u
  WHERE u.id = auth.uid();

  IF caller_email IS NULL OR caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT ua.role
  INTO caller_role
  FROM public.user_access ua
  WHERE lower(trim(ua.email)) = caller_email
  LIMIT 1;

  IF caller_role NOT IN ('admin', 'canvasser') THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', g.id,
          'name', g.name,
          'geometry', g.geometry,
          'assigned_email', g.assigned_email
        )
        ORDER BY g.created_at ASC
      )
      FROM public.geofences g
      WHERE caller_role = 'admin'
         OR lower(trim(coalesce(g.assigned_email, ''))) = caller_email
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.list_visible_geofences() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_visible_geofences() TO authenticated;
