-- Atomic batch save, replacing the old client-side Dexie transaction.
-- SECURITY INVOKER: runs with the caller's own rights, so RLS, column grants
-- and the finalized-batch lock all still apply. Unchanged rows are left alone
-- so auto-save doesn't flood the audit log or invalidate sign-offs.

grant update (created_in_batch_id) on public.givers to authenticated;

create function public.save_batch(
  p_church_id      uuid,
  p_batch          jsonb,     -- {id?, batch_number, batch_date, source}
  p_donations      jsonb,     -- [{id?, giver_id, amount, payment_method, cheque_number, notes, cash_counts, splits:[{fund_id, internal_account_id, amount}]}]
  p_deleted_ids    uuid[] default '{}',
  p_new_giver_ids  uuid[] default '{}'
)
returns jsonb               -- {batch_id, donation_ids: [...] in input order}
language plpgsql security invoker set search_path = ''
as $$
declare
  v_batch   uuid := nullif(p_batch ->> 'id', '')::uuid;
  v_don     uuid;
  v_ids     uuid[] := '{}';
  d         jsonb;
  v_ord     integer := 0;
  v_old_splits jsonb;
  v_new_splits jsonb;
begin
  if v_batch is null then
    insert into public.batches (church_id, batch_number, batch_date, source)
    values (p_church_id,
            p_batch ->> 'batch_number',
            coalesce((p_batch ->> 'batch_date')::date, current_date),
            coalesce((p_batch ->> 'source')::public.batch_source, 'in_person'))
    returning id into v_batch;
  else
    update public.batches
    set batch_date = coalesce((p_batch ->> 'batch_date')::date, batch_date),
        source     = coalesce((p_batch ->> 'source')::public.batch_source, source)
    where id = v_batch and church_id = p_church_id
      and (batch_date, source) is distinct from
          (coalesce((p_batch ->> 'batch_date')::date, batch_date),
           coalesce((p_batch ->> 'source')::public.batch_source, source));
    if not exists (select 1 from public.batches where id = v_batch and church_id = p_church_id and status = 'open') then
      raise exception 'Batch not found or already finalized';
    end if;
  end if;

  if coalesce(array_length(p_deleted_ids, 1), 0) > 0 then
    delete from public.donations where batch_id = v_batch and id = any (p_deleted_ids);
  end if;

  for d in select value from jsonb_array_elements(coalesce(p_donations, '[]'::jsonb)) loop
    v_ord := v_ord + 1;
    v_don := nullif(d ->> 'id', '')::uuid;

    if v_don is null then
      insert into public.donations (church_id, batch_id, giver_id, amount, payment_method,
                                    cheque_number, notes, cash_counts, sort_order)
      values (p_church_id, v_batch, (d ->> 'giver_id')::uuid, (d ->> 'amount')::numeric,
              (d ->> 'payment_method')::public.payment_method,
              nullif(d ->> 'cheque_number', ''), nullif(d ->> 'notes', ''),
              case when d -> 'cash_counts' = 'null'::jsonb then null else d -> 'cash_counts' end,
              v_ord)
      returning id into v_don;
    else
      update public.donations set
        giver_id = (d ->> 'giver_id')::uuid,
        amount = (d ->> 'amount')::numeric,
        payment_method = (d ->> 'payment_method')::public.payment_method,
        cheque_number = nullif(d ->> 'cheque_number', ''),
        notes = nullif(d ->> 'notes', ''),
        cash_counts = case when d -> 'cash_counts' = 'null'::jsonb then null else d -> 'cash_counts' end,
        sort_order = v_ord
      where id = v_don and batch_id = v_batch
        and (giver_id, amount, payment_method, cheque_number, notes, cash_counts, sort_order)
            is distinct from
            ((d ->> 'giver_id')::uuid, (d ->> 'amount')::numeric,
             (d ->> 'payment_method')::public.payment_method,
             nullif(d ->> 'cheque_number', ''), nullif(d ->> 'notes', ''),
             case when d -> 'cash_counts' = 'null'::jsonb then null else d -> 'cash_counts' end,
             v_ord);
      if not exists (select 1 from public.donations where id = v_don and batch_id = v_batch) then
        raise exception 'Donation % does not belong to this batch', v_don;
      end if;
    end if;

    -- Replace splits only when they actually changed
    select coalesce(jsonb_agg(jsonb_build_object('f', s.fund_id, 'i', s.internal_account_id, 'a', s.amount)
                              order by s.fund_id, s.internal_account_id, s.amount), '[]'::jsonb)
    into v_old_splits
    from public.donation_splits s where s.donation_id = v_don;

    select coalesce(jsonb_agg(jsonb_build_object('f', (x ->> 'fund_id')::uuid,
                                                 'i', nullif(x ->> 'internal_account_id', '')::uuid,
                                                 'a', (x ->> 'amount')::numeric(12, 2))
                              order by (x ->> 'fund_id')::uuid, nullif(x ->> 'internal_account_id', '')::uuid,
                                       (x ->> 'amount')::numeric(12, 2)), '[]'::jsonb)
    into v_new_splits
    from jsonb_array_elements(coalesce(d -> 'splits', '[]'::jsonb)) x
    where (x ->> 'amount')::numeric <> 0;

    if v_old_splits is distinct from v_new_splits then
      delete from public.donation_splits where donation_id = v_don;
      insert into public.donation_splits (church_id, donation_id, fund_id, internal_account_id, amount)
      select p_church_id, v_don, (x ->> 'fund_id')::uuid, nullif(x ->> 'internal_account_id', '')::uuid,
             (x ->> 'amount')::numeric
      from jsonb_array_elements(coalesce(d -> 'splits', '[]'::jsonb)) x
      where (x ->> 'amount')::numeric <> 0;
    end if;

    v_ids := v_ids || v_don;
  end loop;

  if coalesce(array_length(p_new_giver_ids, 1), 0) > 0 then
    update public.givers set created_in_batch_id = v_batch
    where church_id = p_church_id and id = any (p_new_giver_ids) and created_in_batch_id is null;
  end if;

  return jsonb_build_object('batch_id', v_batch, 'donation_ids', to_jsonb(v_ids));
end $$;

revoke execute on function public.save_batch(uuid, jsonb, jsonb, uuid[], uuid[]) from public, anon;
grant execute on function public.save_batch(uuid, jsonb, jsonb, uuid[], uuid[]) to authenticated;
