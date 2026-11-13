-- e-Transfer gifts: when a gift is posted, record the sender's e-Transfer
-- email on the giver (first free e-Transfer ID slot), so the registry learns
-- it the same way it learns Pushpay IDs.

create or replace function public.post_external_batch(
  p_church_id  uuid,
  p_provider   public.batch_source,
  p_ids        uuid[],
  p_batch_date date default null,
  -- Reviewer's choices, applied in the same transaction: [{id, giver_id, fund_id}]
  p_resolutions jsonb default '[]'::jsonb
)
returns jsonb               -- {batch_id, batch_number, count, total, fees}
language plpgsql security definer set search_path = ''
as $$
declare
  v_n       integer := coalesce(array_length(p_ids, 1), 0);
  v_found   integer;
  v_bad     text;
  v_batch   uuid;
  v_number  text;
  v_don     uuid;
  v_total   numeric(12, 2) := 0;
  v_fees    numeric(12, 2) := 0;
  v_ord     integer := 0;
  t         public.external_transactions;
  v_label   text := case p_provider::text when 'pushpay' then 'Pushpay'
                                          when 'stripe' then 'Stripe'
                                          when 'e_transfer' then 'e-Transfer'
                                          else p_provider::text end;
begin
  if not private.has_role(p_church_id, array['administrator', 'treasurer']::public.member_role[]) then
    raise exception 'Only an administrator or treasurer can post imported gifts';
  end if;
  if p_provider = 'in_person' then
    raise exception 'in_person is not an external provider';
  end if;
  if v_n = 0 then
    raise exception 'No gifts selected';
  end if;
  if v_n <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'Duplicate gifts in selection';
  end if;

  -- Lock and validate every selected gift
  perform 1 from public.external_transactions
  where id = any (p_ids) and church_id = p_church_id and provider = p_provider
  for update;
  get diagnostics v_found = row_count;
  if v_found <> v_n then
    raise exception 'One or more selected gifts were not found for this church and provider';
  end if;

  update public.external_transactions x set
    giver_id = coalesce(nullif(r ->> 'giver_id', '')::uuid, x.giver_id),
    fund_id  = coalesce(nullif(r ->> 'fund_id', '')::uuid, x.fund_id)
  from jsonb_array_elements(coalesce(p_resolutions, '[]'::jsonb)) r
  where x.id = (r ->> 'id')::uuid and x.id = any (p_ids) and x.donation_id is null;

  select string_agg(external_id || ': ' || reason, '; ') into v_bad from (
    select external_id,
           case when donation_id is not null then 'already posted'
                when ignored then 'ignored'
                when status <> 'succeeded' then 'status is ' || status
                when giver_id is null then 'no giver'
                when fund_id is null then 'no fund'
           end as reason
    from public.external_transactions where id = any (p_ids)) x
  where reason is not null;
  if v_bad is not null then
    raise exception 'Cannot post: %', v_bad;
  end if;

  insert into public.batches (church_id, batch_date, source)
  values (p_church_id,
          coalesce(p_batch_date, (select max(gift_date) from public.external_transactions where id = any (p_ids))),
          p_provider)
  returning id, batch_number into v_batch, v_number;

  for t in
    select * from public.external_transactions where id = any (p_ids)
    order by gift_date, payer_last_name nulls last, payer_first_name nulls last, external_id
  loop
    v_ord := v_ord + 1;
    insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, notes, sort_order)
    values (p_church_id, v_batch, t.giver_id, t.amount, t.payment_method,
            left(v_label || ' ' || t.external_id || coalesce(' — ' || t.memo, ''), 500), v_ord)
    returning id into v_don;

    insert into public.donation_splits (church_id, donation_id, fund_id, amount)
    values (p_church_id, v_don, t.fund_id, t.amount);

    update public.external_transactions set donation_id = v_don, posted_at = now() where id = t.id;

    if t.payer_external_id is not null then
      insert into public.giver_external_ids (church_id, provider, external_id, giver_id)
      values (p_church_id, p_provider, t.payer_external_id, t.giver_id)
      on conflict (church_id, provider, external_id)
      do update set giver_id = excluded.giver_id, updated_at = now();

      if p_provider::text = 'pushpay' then
        update public.givers set pushpay_id = t.payer_external_id
        where id = t.giver_id and not is_system and coalesce(pushpay_id, '') = '';
      elsif p_provider::text = 'e_transfer' then
        -- Learn the sender's e-Transfer email into the first free e-Transfer ID slot
        update public.givers set
          etransfer_id  = case when coalesce(etransfer_id, '') = '' then t.payer_external_id else etransfer_id end,
          etransfer_id2 = case when coalesce(etransfer_id, '') <> '' then t.payer_external_id else etransfer_id2 end
        where id = t.giver_id and not is_system
          and lower(t.payer_external_id) not in (lower(coalesce(etransfer_id, '')), lower(coalesce(etransfer_id2, '')))
          and (coalesce(etransfer_id, '') = '' or coalesce(etransfer_id2, '') = '');
      end if;
    end if;

    if coalesce(t.fund_key, t.fund_name) is not null then
      insert into public.external_fund_map (church_id, provider, external_key, fund_id)
      values (p_church_id, p_provider, lower(trim(coalesce(t.fund_key, t.fund_name))), t.fund_id)
      on conflict (church_id, provider, external_key)
      do update set fund_id = excluded.fund_id, updated_at = now();
    end if;

    v_total := v_total + t.amount;
    v_fees  := v_fees + t.fee;
  end loop;

  return jsonb_build_object('batch_id', v_batch, 'batch_number', v_number,
                            'count', v_n, 'total', v_total, 'fees', v_fees);
end $$;

