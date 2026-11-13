-- Cover the two created_by foreign keys flagged by the performance advisor.
create index batches_created_by_idx on public.batches (created_by);
create index churches_created_by_idx on public.churches (created_by);
