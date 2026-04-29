-- Backfill RPC functions that exist in production but were missing from repo migrations.
-- Definitions are copied from the live database to preserve behavior.

CREATE OR REPLACE FUNCTION public.addresses_in_viewport_by_proximity(south double precision, north double precision, west double precision, east double precision, clat double precision, clong double precision, row_limit integer)
 RETURNS TABLE(id uuid, full_address text, lat double precision, long double precision, canvassed boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select a.id, a.full_address, a.lat, a.long, a.canvassed
  from public.addresses a
  where a.lat >= south
    and a.lat <= north
    and a.long >= west
    and a.long <= east
  order by
    ((a.lat - clat) * (a.lat - clat) + (a.long - clong) * (a.long - clong))
  limit greatest(1, least(coalesce(row_limit, 4000), 20000));
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_user_access(target_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  normalized_email text := lower(trim(target_email));
begin
  if not public.is_admin() then
    raise exception 'Only admins can manage access.';
  end if;
  if normalized_email is null or normalized_email = '' then
    raise exception 'Email is required.';
  end if;
  if (
    select count(*)
    from (
      select lower(ua.email) as email
      from public.user_access ua
      where ua.role = 'admin'
      union
      select lower(p.email) as email
      from public.profiles p
      where p.role = 'admin'
    ) admins
    where admins.email <> normalized_email
  ) = 0 then
    raise exception 'Cannot remove the last admin.';
  end if;
  delete from public.user_access
  where email = normalized_email;
  update public.profiles
  set role = 'canvasser'
  where lower(email) = normalized_email
    and role = 'admin';
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_geofence_progress(p_geofence_id uuid)
 RETURNS TABLE(total_count integer, canvassed_count integer, remaining_count integer)
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
    select a.canvassed
    from public.addresses a
    where st_contains(
      v_geom,
      st_setsrid(st_makepoint(a.long, a.lat), 4326)
    )
  )
  select
    count(*)::integer as total_count,
    count(*) filter (where canvassed)::integer as canvassed_count,
    (count(*) - count(*) filter (where canvassed))::integer as remaining_count
  from inside;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_mark_geofence_addresses_canvassed(p_geofence_id uuid, p_canvassed boolean DEFAULT true)
 RETURNS TABLE(updated_count integer, already_canvassed integer, total_count integer)
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
    select a.id, a.canvassed
    from public.addresses a
    where st_contains(
      v_geom,
      st_setsrid(st_makepoint(a.long, a.lat), 4326)
    )
  ),
  updated as (
    update public.addresses a
    set
      canvassed = p_canvassed,
      updated_at = now(),
      updated_by = v_uid
    where a.id in (
      select i.id
      from inside i
      where i.canvassed is distinct from p_canvassed
    )
    returning a.id
  )
  select
    (select count(*)::integer from updated) as updated_count,
    (select count(*)::integer from inside where canvassed = p_canvassed) as already_canvassed,
    (select count(*)::integer from inside) as total_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_user_access(target_email text, target_role text, target_first_name text DEFAULT NULL::text, target_last_name text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  normalized_email text := lower(trim(target_email));
  target_user_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can manage access.';
  end if;

  if normalized_email is null or normalized_email = '' then
    raise exception 'Email is required.';
  end if;

  if target_role not in ('admin', 'canvasser') then
    raise exception 'Role must be admin or canvasser.';
  end if;

  if target_role = 'canvasser' then
    if (
      select count(*)
      from (
        select lower(ua.email) as email
        from public.user_access ua
        where ua.role = 'admin'
        union
        select lower(p.email) as email
        from public.profiles p
        where p.role = 'admin'
      ) admins
      where admins.email <> normalized_email
    ) = 0 then
      raise exception 'Cannot remove the last admin.';
    end if;
  end if;

  insert into public.user_access (email, role, first_name, last_name)
  values (normalized_email, target_role, target_first_name, target_last_name)
  on conflict (email) do update
  set
    role = excluded.role,
    first_name = excluded.first_name,
    last_name = excluded.last_name;

  select id
  into target_user_id
  from auth.users
  where lower(email) = normalized_email
  limit 1;

  if target_user_id is not null then
    insert into public.profiles (id, email, role)
    values (target_user_id, normalized_email, target_role)
    on conflict (id) do update
    set
      email = excluded.email,
      role = excluded.role;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_user_email(old_email text, new_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  normalized_old text := lower(trim(old_email));
  normalized_new text := lower(trim(new_email));
begin
  if not public.is_admin() then
    raise exception 'Only admins can manage access.';
  end if;
  if normalized_old is null or normalized_old = '' or normalized_new is null or normalized_new = '' then
    raise exception 'Both old and new email are required.';
  end if;
  update public.user_access
  set email = normalized_new
  where email = normalized_old;
  if not found then
    raise exception 'No access record found for %.', normalized_old;
  end if;
  update public.profiles
  set email = normalized_new
  where lower(email) = normalized_old;
end;
$function$;

CREATE OR REPLACE FUNCTION public.can_request_magic_link(target_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.user_access ua
    where ua.email = lower(trim(target_email))
  )
  or exists (
    select 1
    from public.profiles p
    where lower(trim(p.email)) = lower(trim(target_email))
  );
$function$;

CREATE OR REPLACE FUNCTION public.canvasser_set_address_canvassed(p_address_id uuid, p_canvassed boolean)
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
    canvassed = p_canvassed,
    updated_at = now(),
    updated_by = v_uid
  where id = p_address_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sync_profile_from_access()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  current_user_id uuid := auth.uid();
  current_email text := lower(trim(auth.jwt() ->> 'email'));
  access_role text;
begin
  if current_user_id is null or current_email is null or current_email = '' then
    return;
  end if;
  select ua.role
  into access_role
  from public.user_access ua
  where ua.email = current_email
  limit 1;
  if access_role is null then
    return;
  end if;
  insert into public.profiles (id, email, role)
  values (current_user_id, current_email, access_role)
  on conflict (id) do update
  set
    email = excluded.email,
    role = excluded.role;
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

REVOKE ALL ON FUNCTION public.admin_delete_user_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_user_access(text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_geofence_progress(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_geofence_progress(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_mark_geofence_addresses_canvassed(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_mark_geofence_addresses_canvassed(uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_set_user_access(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_access(text, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_update_user_email(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_user_email(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.can_request_magic_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_request_magic_link(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.canvasser_set_address_canvassed(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.canvasser_set_address_canvassed(uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.sync_profile_from_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_profile_from_access() TO authenticated;
