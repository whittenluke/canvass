-- Admin Access panel: return merged user_access + profile presence in one call.
-- Runs as SECURITY DEFINER so RLS on user_access / profiles does not run (avoids
-- "stack depth limit exceeded" when policies or views reference each other).

CREATE OR REPLACE FUNCTION public.admin_list_access_panel()
RETURNS jsonb
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

  RETURN COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'email', ua.email,
          'role', ua.role,
          'first_name', ua.first_name,
          'last_name', ua.last_name,
          'profile_exists',
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE lower(trim(p.email)) = lower(trim(ua.email))
          )
        )
        ORDER BY ua.email
      )
      FROM public.user_access ua
      WHERE ua.role IN ('admin', 'canvasser')
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_access_panel() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_access_panel() TO authenticated;
