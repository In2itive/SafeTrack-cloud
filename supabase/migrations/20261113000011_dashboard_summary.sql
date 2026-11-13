-- Year-to-date figures for the dashboard, computed in the database.
-- (Summing in the browser would silently truncate: the API returns at most
-- 1000 rows per request.) SECURITY INVOKER: RLS limits it to the caller's church.
-- The year is the batch-date year, matching batch numbering.
create function public.dashboard_summary(p_church_id uuid, p_year integer)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with yr as (
    select b.id as batch_id, b.batch_date, d.amount
    from public.batches b
    left join public.donations d on d.batch_id = b.id
    where b.church_id = p_church_id
      and b.batch_date >= make_date(p_year, 1, 1)
      and b.batch_date <  make_date(p_year + 1, 1, 1)
  )
  select jsonb_build_object(
    'year',     p_year,
    'total',    coalesce((select sum(amount) from yr), 0),
    'count',    (select count(amount) from yr),
    'batches',  (select count(distinct batch_id) from yr),
    'by_month', (select jsonb_agg(coalesce(m.total, 0) order by gs.mon)
                 from generate_series(1, 12) as gs(mon)
                 left join (select extract(month from batch_date)::integer as mon, sum(amount) as total
                            from yr group by 1) m on m.mon = gs.mon)
  )
$$;

revoke execute on function public.dashboard_summary(uuid, integer) from public, anon;
grant execute on function public.dashboard_summary(uuid, integer) to authenticated;
