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
    select
      count(*)::integer as total_count,
      count(*) filter (where inside.canvassed)::integer as canvassed_count,
      (count(*) - count(*) filter (where inside.canvassed))::integer as remaining_count
    from (
      select a.canvassed
      from public.addresses a
      where st_contains(
        st_makevalid(st_setsrid(st_geomfromgeojson(g.geometry::text), 4326)),
        st_setsrid(st_makepoint(a.long, a.lat), 4326)
      )
    ) inside
  ) s;
end;
$function$;

REVOKE ALL ON FUNCTION public.admin_list_geofence_progress() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_geofence_progress() TO authenticated;
