-- Run in Supabase SQL editor (or via CLI migrate) so the app can show
-- "Create a password" vs "Sign in" after the email gate.

CREATE OR REPLACE FUNCTION public.access_email_auth_intent(target_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE lower(trim(ua.email)) = lower(trim(target_email))
    ) THEN 'not_allowed'
    WHEN EXISTS (
      SELECT 1 FROM auth.users u
      WHERE lower(trim(u.email)) = lower(trim(target_email))
    ) THEN 'sign_in'
    ELSE 'create_password'
  END;
$$;

REVOKE ALL ON FUNCTION public.access_email_auth_intent(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.access_email_auth_intent(text) TO anon, authenticated;
