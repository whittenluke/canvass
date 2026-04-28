-- Single-address canvassed toggle for admins: bypasses RLS on `addresses`
-- (avoids "stack depth limit exceeded" when policies/triggers recurse).

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
  SET canvassed = p_canvassed
  WHERE id = p_address_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'address not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_address_canvassed(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_address_canvassed(uuid, boolean) TO authenticated;
