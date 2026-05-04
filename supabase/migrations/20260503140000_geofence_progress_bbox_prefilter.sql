-- Geofence progress RPCs used to filter addresses with st_contains only, which forces
-- a full scan of public.addresses on large datasets. Prefilter by the polygon envelope
-- (axis-aligned bbox in degrees) so index-friendly lat/long predicates shrink the set
-- before PostGIS containment checks.

CREATE INDEX IF NOT EXISTS addresses_lat_long_bbox_idx ON public.addresses (lat, long);

ANALYZE public.addresses;

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
  with env as (
    select
      v_geom as geom,
      st_ymin(st_envelope(v_geom)) as ymin,
      st_ymax(st_envelope(v_geom)) as ymax,
      st_xmin(st_envelope(v_geom)) as xmin,
      st_xmax(st_envelope(v_geom)) as xmax
  ),
  inside as (
    select a.canvassed
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
    (count(*) - count(*) filter (where canvassed))::integer as remaining_count
  from inside;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_geofence_progress()
 RETURNS TABLE(geofence_id uuid, total_count integer, canvassed_count integer, remaining_count integer)
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
    coalesce(s.remaining_count, 0)::integer
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
      (count(*) - count(*) filter (where inside.canvassed))::integer as remaining_count
    from (
      select a.canvassed
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
