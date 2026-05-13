-- Leaderboard: net marks per contributor (sign-on minus sign-off), floored at zero.
-- Previously only transitions to true were counted, so cleared petitions/canvass still
-- inflated scores vs current reality.

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
  WITH per_actor AS (
    SELECT
      e.actor_id,
      lower(trim(coalesce(au.email, ''))) AS actor_email,
      e.actor_role,
      GREATEST(
        0::bigint,
        count(*) FILTER (
          WHERE e.canvassed_before IS DISTINCT FROM e.canvassed_after
            AND e.canvassed_after = true
        )
        - count(*) FILTER (
          WHERE e.canvassed_before IS DISTINCT FROM e.canvassed_after
            AND e.canvassed_after = false
        )
      )::bigint AS canvassed_marks,
      GREATEST(
        0::bigint,
        count(*) FILTER (
          WHERE e.signed_petition_before IS DISTINCT FROM e.signed_petition_after
            AND e.signed_petition_after = true
        )
        - count(*) FILTER (
          WHERE e.signed_petition_before IS DISTINCT FROM e.signed_petition_after
            AND e.signed_petition_after = false
        )
      )::bigint AS petition_marks
    FROM public.address_status_events e
    LEFT JOIN auth.users au ON au.id = e.actor_id
    WHERE e.actor_id IS NOT NULL
      AND (p_since IS NULL OR e.occurred_at >= p_since)
    GROUP BY e.actor_id, lower(trim(coalesce(au.email, ''))), e.actor_role
  )
  SELECT
    p.actor_id,
    p.actor_email,
    p.actor_role,
    p.canvassed_marks,
    p.petition_marks
  FROM per_actor p
  WHERE p.canvassed_marks + p.petition_marks > 0
  ORDER BY p.canvassed_marks + p.petition_marks DESC, p.actor_email ASC;
END;
$$;
