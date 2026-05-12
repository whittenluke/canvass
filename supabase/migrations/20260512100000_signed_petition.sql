-- Signed petition (parallel to canvassed): column, viewport RPC, progress RPCs, writes, bulk admin.

ALTER TABLE public.addresses
  ADD COLUMN IF NOT EXISTS signed_petition boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.addresses.signed_petition IS 'Whether a petition was signed at this address (independent of canvassed).';

-- Postgres does not allow CREATE OR REPLACE when RETURNS TABLE / OUT row shape changes.
DROP FUNCTION IF EXISTS public.addresses_in_viewport_by_proximity(
  double precision, double precision, double precision, double precision,
  double precision, double precision, integer
);
DROP FUNCTION IF EXISTS public.admin_get_geofence_progress(uuid);
DROP FUNCTION IF EXISTS public.admin_list_geofence_progress();

-- Viewport listing: include signed_petition
CREATE OR REPLACE FUNCTION public.addresses_in_viewport_by_proximity(
  south double precision,
  north double precision,
  west double precision,
  east double precision,
  clat double precision,
  clong double precision,
  row_limit integer
)
RETURNS TABLE(
  id uuid,
  full_address text,
  lat double precision,
  long double precision,
  canvassed boolean,
  signed_petition boolean
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  select a.id, a.full_address, a.lat, a.long, a.canvassed, a.signed_petition
  from public.addresses a
  where a.lat >= south
    and a.lat <= north
    and a.long >= west
    and a.long <= east
  order by
    ((a.lat - clat) * (a.lat - clat) + (a.long - clong) * (a.long - clong))
  limit greatest(1, least(coalesce(row_limit, 4000), 20000));
$function$;

-- Single-address petition: admin
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
  SET signed_petition = p_signed
  WHERE id = p_address_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'address not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_address_signed_petition(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_address_signed_petition(uuid, boolean) TO authenticated;

-- Single-address petition: canvasser (same geofence containment as canvasser_set_address_canvassed)
CREATE OR REPLACE FUNCTION public.canvasser_set_address_signed_petition(p_address_id uuid, p_signed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_email text;
  v_lat double precision;
  v_long double precision;
  v_ok boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  select p.role, lower(trim(p.email))
  into v_role, v_email
  from public.profiles p
  where p.id = v_uid;
  if v_role is null then
    raise exception 'Profile not found';
  end if;
  if v_role = 'admin' then
    raise exception 'Admins update addresses directly in the app';
  end if;
  if v_role <> 'canvasser' then
    raise exception 'Only canvassers may use this action';
  end if;
  if v_email is null or v_email = '' then
    raise exception 'Profile email is missing';
  end if;
  select a.lat, a.long
  into v_lat, v_long
  from public.addresses a
  where a.id = p_address_id;
  if not found then
    raise exception 'Address not found';
  end if;
  select exists (
    select 1
    from public.geofences g
    where lower(trim(g.assigned_email)) = v_email
      and g.geometry is not null
      and st_contains(
        st_makevalid(st_setsrid(st_geomfromgeojson(g.geometry::text), 4326)),
        st_setsrid(st_makepoint(v_long, v_lat), 4326)
      )
  )
  into v_ok;
  if not coalesce(v_ok, false) then
    raise exception 'Address is outside your assigned geofences';
  end if;
  update public.addresses
  set
    signed_petition = p_signed,
    updated_at = now(),
    updated_by = v_uid
  where id = p_address_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.canvasser_set_address_signed_petition(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.canvasser_set_address_signed_petition(uuid, boolean) TO authenticated;

-- Bulk mark signed petition inside geofence (admin)
CREATE OR REPLACE FUNCTION public.admin_mark_geofence_addresses_signed_petition(
  p_geofence_id uuid,
  p_signed boolean DEFAULT true
)
RETURNS TABLE(
  updated_count integer,
  already_signed integer,
  total_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_geom geometry;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  select p.role
  into v_role
  from public.profiles p
  where p.id = v_uid;
  if v_role <> 'admin' then
    raise exception 'Only admins may use this action';
  end if;
  select st_makevalid(st_setsrid(st_geomfromgeojson(g.geometry::text), 4326))
  into v_geom
  from public.geofences g
  where g.id = p_geofence_id;
  if v_geom is null then
    raise exception 'Geofence not found';
  end if;
  return query
  with inside as (
    select a.id, a.signed_petition
    from public.addresses a
    where st_contains(
      v_geom,
      st_setsrid(st_makepoint(a.long, a.lat), 4326)
    )
  ),
  updated as (
    update public.addresses a
    set
      signed_petition = p_signed,
      updated_at = now(),
      updated_by = v_uid
    where a.id in (
      select i.id
      from inside i
      where i.signed_petition is distinct from p_signed
    )
    returning a.id
  )
  select
    (select count(*)::integer from updated) as updated_count,
    (select count(*)::integer from inside where signed_petition = p_signed) as already_signed,
    (select count(*)::integer from inside) as total_count;
end;
$function$;

REVOKE ALL ON FUNCTION public.admin_mark_geofence_addresses_signed_petition(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_mark_geofence_addresses_signed_petition(uuid, boolean) TO authenticated;

-- Progress for one geofence: add petition counts
CREATE OR REPLACE FUNCTION public.admin_get_geofence_progress(p_geofence_id uuid)
RETURNS TABLE(
  total_count integer,
  canvassed_count integer,
  remaining_count integer,
  petition_signed_count integer,
  petition_remaining_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_geom geometry;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  select p.role
  into v_role
  from public.profiles p
  where p.id = v_uid;
  if v_role <> 'admin' then
    raise exception 'Only admins may use this action';
  end if;
  select st_makevalid(st_setsrid(st_geomfromgeojson(g.geometry::text), 4326))
  into v_geom
  from public.geofences g
  where g.id = p_geofence_id;
  if v_geom is null then
    raise exception 'Geofence not found';
  end if;
  return query
  with env as (
    select
      v_geom as geom,
      st_ymin(st_envelope(v_geom)) as ymin,
      st_ymax(st_envelope(v_geom)) as ymax,
      st_xmin(st_envelope(v_geom)) as xmin,
      st_xmax(st_envelope(v_geom)) as xmax
  ),
  inside as (
    select a.canvassed, a.signed_petition
    from public.addresses a
    cross join env e
    where a.lat >= e.ymin
      and a.lat <= e.ymax
      and (
        (e.xmin <= e.xmax and a.long >= e.xmin and a.long <= e.xmax)
        or (e.xmin > e.xmax and (a.long >= e.xmin or a.long <= e.xmax))
      )
      and st_contains(e.geom, st_setsrid(st_makepoint(a.long, a.lat), 4326))
  )
  select
    count(*)::integer as total_count,
    count(*) filter (where canvassed)::integer as canvassed_count,
    (count(*) - count(*) filter (where canvassed))::integer as remaining_count,
    count(*) filter (where signed_petition)::integer as petition_signed_count,
    (count(*) - count(*) filter (where signed_petition))::integer as petition_remaining_count
  from inside;
end;
$function$;

-- List progress for all geofences
CREATE OR REPLACE FUNCTION public.admin_list_geofence_progress()
RETURNS TABLE(
  geofence_id uuid,
  total_count integer,
  canvassed_count integer,
  remaining_count integer,
  petition_signed_count integer,
  petition_remaining_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  select p.role
  into v_role
  from public.profiles p
  where p.id = v_uid;
  if v_role <> 'admin' then
    raise exception 'Only admins may use this action';
  end if;

  return query
  select
    g.id as geofence_id,
    coalesce(s.total_count, 0)::integer,
    coalesce(s.canvassed_count, 0)::integer,
    coalesce(s.remaining_count, 0)::integer,
    coalesce(s.petition_signed_count, 0)::integer,
    coalesce(s.petition_remaining_count, 0)::integer
  from public.geofences g
  cross join lateral (
    with poly as (
      select st_makevalid(st_setsrid(st_geomfromgeojson(g.geometry::text), 4326)) as geom
    ),
    env as (
      select
        p.geom,
        st_ymin(st_envelope(p.geom)) as ymin,
        st_ymax(st_envelope(p.geom)) as ymax,
        st_xmin(st_envelope(p.geom)) as xmin,
        st_xmax(st_envelope(p.geom)) as xmax
      from poly p
    )
    select
      count(*)::integer as total_count,
      count(*) filter (where inside.canvassed)::integer as canvassed_count,
      (count(*) - count(*) filter (where inside.canvassed))::integer as remaining_count,
      count(*) filter (where inside.signed_petition)::integer as petition_signed_count,
      (count(*) - count(*) filter (where inside.signed_petition))::integer as petition_remaining_count
    from (
      select a.canvassed, a.signed_petition
      from public.addresses a
      cross join env e
      where a.lat >= e.ymin
        and a.lat <= e.ymax
        and (
          (e.xmin <= e.xmax and a.long >= e.xmin and a.long <= e.xmax)
          or (e.xmin > e.xmax and (a.long >= e.xmin or a.long <= e.xmax))
        )
        and st_contains(e.geom, st_setsrid(st_makepoint(a.long, a.lat), 4326))
    ) inside
  ) s;
end;
$function$;

REVOKE ALL ON FUNCTION public.addresses_in_viewport_by_proximity(
  double precision, double precision, double precision, double precision,
  double precision, double precision, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.addresses_in_viewport_by_proximity(
  double precision, double precision, double precision, double precision,
  double precision, double precision, integer
) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_geofence_progress(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_geofence_progress(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_list_geofence_progress() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_geofence_progress() TO authenticated;
