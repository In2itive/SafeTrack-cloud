-- Import a backup file from the original browser-only SafeTrack
-- (Admin / Backup -> Generate Backup) into a church.
--
-- Rules:
--  * Administrator only, and only into a church with no batches yet
--    (so a double import can't duplicate money).
--  * Finalized batches stay finalized. Their original teller names are kept
--    in legacy_finalized_by because those people have no cloud accounts.
--  * Users are NOT imported (old password hashes are weak by design);
--    the admin invites people instead. The count is reported back.
--  * Data the new schema requires but old records may lack is filled in
--    and counted, never silently dropped.

alter table public.batches add column legacy_finalized_by text[];

create function public.import_legacy_backup(p_church_id uuid, p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_loose     uuid;
  v_internal  uuid;
  v_giver_map jsonb := '{}';
  v_batch_map jsonb := '{}';
  v_fund      record;
  r           jsonb;
  s           jsonb;
  v_id        uuid;
  v_fund_id   uuid;
  v_acct_id   uuid;
  v_settings  jsonb;
  v_counts    jsonb := jsonb_build_object(
                'givers', 0, 'batches', 0, 'finalized_batches', 0, 'donations', 0,
                'funds_added', 0, 'internal_accounts_added', 0,
                'users_not_imported', coalesce(jsonb_array_length(p_data -> 'users'), 0),
                'fixed_missing_cheque_numbers', 0, 'fixed_missing_cash_counts', 0,
                'skipped_donations_unknown_giver', 0, 'renumbered_duplicate_envelopes', 0);
  v_method    public.payment_method;
  v_cheque    text;
  v_cash      jsonb;
  v_giver     uuid;
  v_env       integer;
begin
  if not private.is_admin(p_church_id) then
    raise exception 'Only an administrator can import a backup';
  end if;
  if exists (select 1 from public.batches where church_id = p_church_id) then
    raise exception 'This church already has batches. Import is only allowed into an empty church.';
  end if;
  if jsonb_typeof(p_data -> 'givers') is distinct from 'array' or jsonb_typeof(p_data -> 'batches') is distinct from 'array' then
    raise exception 'This does not look like a SafeTrack backup file';
  end if;

  select id into v_loose    from public.givers where church_id = p_church_id and is_system and envelope_number = 0;
  select id into v_internal from public.givers where church_id = p_church_id and is_system and envelope_number = 1;

  -- Settings (first row of the old settings table)
  v_settings := p_data -> 'settings' -> 0;
  if v_settings is not null then
    update public.church_settings set
      accounting_recipients = coalesce(array(select trim(x) from unnest(string_to_array(v_settings ->> 'accountingRecipients', ',')) x where trim(x) <> ''), '{}'),
      envelope_recipients   = coalesce(array(select trim(x) from unnest(string_to_array(v_settings ->> 'envelopeRecipients', ',')) x where trim(x) <> ''), '{}'),
      deposit_recipients    = coalesce(array(select trim(x) from unnest(string_to_array(v_settings ->> 'depositRecipients', ',')) x where trim(x) <> ''), '{}'),
      bank_logo            = v_settings ->> 'bankLogo',
      account_of           = v_settings ->> 'accountOf',
      branch_number        = v_settings ->> 'branchNumber',
      account_number       = v_settings ->> 'accountNumber',
      church_logo          = v_settings ->> 'churchLogo',
      church_address_line1 = v_settings ->> 'churchAddressLine1',
      church_address_line2 = v_settings ->> 'churchAddressLine2',
      church_address_line3 = v_settings ->> 'churchAddressLine3'
    where church_id = p_church_id;

    if coalesce(v_settings ->> 'smtpHost', '') <> '' then
      insert into private.church_smtp (church_id, host, port, username, password, from_address)
      values (p_church_id, v_settings ->> 'smtpHost', coalesce((v_settings ->> 'smtpPort')::integer, 587),
              coalesce(v_settings ->> 'smtpUser', ''), coalesce(v_settings ->> 'smtpPassword', ''),
              coalesce(v_settings ->> 'smtpFrom', ''))
      on conflict (church_id) do update set host = excluded.host, port = excluded.port,
        username = excluded.username, password = excluded.password,
        from_address = excluded.from_address, updated_at = now();
    end if;
  end if;

  -- Funds: keep system funds, add custom ones, carry the active flag
  for r in select value from jsonb_array_elements(coalesce(p_data -> 'funds', '[]')) loop
    select id into v_fund_id from public.funds where church_id = p_church_id and lower(name) = lower(r ->> 'name');
    if v_fund_id is null then
      insert into public.funds (church_id, name, is_system, is_active, sort_order)
      values (p_church_id, r ->> 'name', false, coalesce((r ->> 'isActive')::boolean, true), 100)
      returning id into v_fund_id;
      v_counts := jsonb_set(v_counts, '{funds_added}', to_jsonb((v_counts ->> 'funds_added')::int + 1));
    else
      update public.funds set is_active = coalesce((r ->> 'isActive')::boolean, true) where id = v_fund_id;
    end if;
  end loop;

  -- Internal accounts
  for r in select value from jsonb_array_elements(coalesce(p_data -> 'internalAccounts', '[]')) loop
    if not exists (select 1 from public.internal_accounts where church_id = p_church_id and lower(code) = lower(r ->> 'name')) then
      insert into public.internal_accounts (church_id, code, is_active)
      values (p_church_id, r ->> 'name', coalesce((r ->> 'isActive')::boolean, true));
      v_counts := jsonb_set(v_counts, '{internal_accounts_added}', to_jsonb((v_counts ->> 'internal_accounts_added')::int + 1));
    end if;
  end loop;

  -- Givers (old numeric id -> new uuid)
  for r in select value from jsonb_array_elements(p_data -> 'givers') loop
    v_env := (r ->> 'envelopeNumber')::integer;
    if v_env is null or v_env < 2 then
      continue;  -- 0/1 are the seeded system givers
    end if;
    if exists (select 1 from public.givers where church_id = p_church_id and envelope_number = v_env) then
      v_env := null;  -- duplicate envelope # in the old data: assign the next free number
      v_counts := jsonb_set(v_counts, '{renumbered_duplicate_envelopes}', to_jsonb((v_counts ->> 'renumbered_duplicate_envelopes')::int + 1));
    end if;
    insert into public.givers (church_id, envelope_number, name, name2, email, email2,
                               address1, address2, address3, etransfer_id, etransfer_id2, pushpay_id)
    values (p_church_id, v_env, coalesce(nullif(trim(r ->> 'name'), ''), 'Unnamed #' || coalesce((r ->> 'envelopeNumber'), '?')),
            nullif(r ->> 'name2', ''), nullif(r ->> 'email', ''), nullif(r ->> 'email2', ''),
            nullif(r ->> 'address1', ''), nullif(r ->> 'address2', ''), nullif(r ->> 'address3', ''),
            nullif(r ->> 'eTransferId', ''), nullif(r ->> 'eTransferId2', ''), nullif(r ->> 'pushPayId', ''))
    returning id into v_id;
    v_giver_map := v_giver_map || jsonb_build_object(r ->> 'id', v_id);
    v_counts := jsonb_set(v_counts, '{givers}', to_jsonb((v_counts ->> 'givers')::int + 1));
  end loop;

  -- Restore the envelope counter (inserting givers may already have pushed it higher)
  if v_settings ? 'nextEnvelopeNumber' then
    update public.church_settings
    set next_envelope_number = greatest(next_envelope_number, (v_settings ->> 'nextEnvelopeNumber')::integer)
    where church_id = p_church_id;
  end if;

  -- Batches, inserted open; finalized ones are locked after their donations go in
  for r in select value from jsonb_array_elements(p_data -> 'batches') loop
    insert into public.batches (church_id, batch_number, batch_date, source, created_by)
    values (p_church_id,
            coalesce(nullif(r ->> 'batchNumber', ''), 'LEGACY-' || (r ->> 'id')),
            coalesce((r ->> 'date')::date, current_date),
            case r ->> 'source' when 'E-Transfer' then 'e_transfer'::public.batch_source
                                when 'PushPay' then 'pushpay'::public.batch_source
                                else 'in_person'::public.batch_source end,
            (select auth.uid()))
    returning id into v_id;
    v_batch_map := v_batch_map || jsonb_build_object(r ->> 'id', v_id);
    v_counts := jsonb_set(v_counts, '{batches}', to_jsonb((v_counts ->> 'batches')::int + 1));

    -- Givers created during this batch
    update public.givers set created_in_batch_id = v_id
    where church_id = p_church_id
      and id in (select (v_giver_map ->> (x #>> '{}'))::uuid
                 from jsonb_array_elements(coalesce(r -> 'newGiverIds', '[]')) x
                 where v_giver_map ? (x #>> '{}'));
  end loop;

  -- Donations
  for r in select value from jsonb_array_elements(coalesce(p_data -> 'donations', '[]')) loop
    v_giver := case (r ->> 'giverId')
                 when '0' then v_loose
                 when '-1' then v_internal
                 else (v_giver_map ->> (r ->> 'giverId'))::uuid end;
    if v_giver is null or not (v_batch_map ? (r ->> 'batchId')) then
      v_counts := jsonb_set(v_counts, '{skipped_donations_unknown_giver}',
                            to_jsonb((v_counts ->> 'skipped_donations_unknown_giver')::int + 1));
      continue;
    end if;

    v_method := case r ->> 'paymentMethod' when 'Cash' then 'cash'::public.payment_method
                                           when 'E-Transfer' then 'e_transfer'::public.payment_method
                                           else 'cheque'::public.payment_method end;
    v_cheque := nullif(trim(coalesce(r ->> 'chequeNumber', '')), '');
    if v_method = 'cheque' and v_cheque is null then
      v_cheque := 'UNKNOWN';
      v_counts := jsonb_set(v_counts, '{fixed_missing_cheque_numbers}', to_jsonb((v_counts ->> 'fixed_missing_cheque_numbers')::int + 1));
    end if;
    v_cash := case when v_method = 'cash' then
                (select coalesce(jsonb_object_agg(e.key, (e.value)::numeric::integer), '{}'::jsonb)
                 from jsonb_each_text(coalesce(r -> 'cashCounts', '{}')) e
                 where e.value ~ '^[0-9]+(\.0+)?$' and e.value::numeric > 0)
              end;
    if v_method = 'cash' and v_cash = '{}'::jsonb then
      v_counts := jsonb_set(v_counts, '{fixed_missing_cash_counts}', to_jsonb((v_counts ->> 'fixed_missing_cash_counts')::int + 1));
    end if;

    insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, cheque_number, notes, cash_counts, sort_order)
    values (p_church_id, (v_batch_map ->> (r ->> 'batchId'))::uuid, v_giver,
            round((r ->> 'amount')::numeric, 2), v_method,
            case when v_method = 'cheque' then v_cheque else nullif(trim(coalesce(r ->> 'chequeNumber', '')), '') end,
            nullif(r ->> 'notes', ''), v_cash, coalesce((r ->> 'id')::integer, 0))
    returning id into v_id;
    v_counts := jsonb_set(v_counts, '{donations}', to_jsonb((v_counts ->> 'donations')::int + 1));

    -- Splits (default: whole amount to General)
    for s in select value from jsonb_array_elements(
               case when jsonb_typeof(r -> 'splits') = 'array' and jsonb_array_length(r -> 'splits') > 0 then r -> 'splits'
                    else jsonb_build_array(jsonb_build_object('fund', 'General', 'amount', r -> 'amount')) end) loop
      continue when coalesce((s ->> 'amount')::numeric, 0) = 0;
      select id into v_fund_id from public.funds where church_id = p_church_id and lower(name) = lower(coalesce(s ->> 'fund', 'General'));
      if v_fund_id is null then
        insert into public.funds (church_id, name, is_active, sort_order) values (p_church_id, s ->> 'fund', false, 100)
        returning id into v_fund_id;
        v_counts := jsonb_set(v_counts, '{funds_added}', to_jsonb((v_counts ->> 'funds_added')::int + 1));
      end if;
      v_acct_id := null;
      if coalesce(s ->> 'internalAccount', '') <> '' then
        select id into v_acct_id from public.internal_accounts where church_id = p_church_id and lower(code) = lower(s ->> 'internalAccount');
        if v_acct_id is null then
          insert into public.internal_accounts (church_id, code, is_active) values (p_church_id, s ->> 'internalAccount', false)
          returning id into v_acct_id;
          v_counts := jsonb_set(v_counts, '{internal_accounts_added}', to_jsonb((v_counts ->> 'internal_accounts_added')::int + 1));
        end if;
      end if;
      insert into public.donation_splits (church_id, donation_id, fund_id, internal_account_id, amount)
      values (p_church_id, v_id, v_fund_id, v_acct_id, round((s ->> 'amount')::numeric, 2));
    end loop;
  end loop;

  -- Lock the batches that were finalized in the old system
  perform set_config('safetrack.allow_locked_changes', 'on', true);
  for r in select value from jsonb_array_elements(p_data -> 'batches') where value ->> 'status' = 'Finalized' loop
    update public.batches
    set status = 'finalized', finalized_at = now(),
        legacy_finalized_by = array(select jsonb_array_elements_text(coalesce(r -> 'finalizedBy', '[]')))
    where id = (v_batch_map ->> (r ->> 'id'))::uuid;
    v_counts := jsonb_set(v_counts, '{finalized_batches}', to_jsonb((v_counts ->> 'finalized_batches')::int + 1));
  end loop;
  perform set_config('safetrack.allow_locked_changes', 'off', true);

  return v_counts;
end $$;

revoke execute on function public.import_legacy_backup(uuid, jsonb) from public, anon;
grant execute on function public.import_legacy_backup(uuid, jsonb) to authenticated;
