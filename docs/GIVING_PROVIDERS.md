# Online giving providers

SafeTrack brings online gifts in as ordinary batches that still go through
two-person sign-off. Pushpay is the first provider. The design lets our own
Stripe giving module replace it without changing the matching, posting or
controls.

```
 Pushpay CSV ──► FileProvider.parse() ─┐
                                       ├─► stage_external_transactions ──► external_transactions (review queue)
 Stripe webhook ──► normalise ─────────┘     (deduped on provider + external_id)
                                                     │
                       Online Giving screen: match giver + fund (remembered per provider)
                                                     │
                                       post_external_batch() ──► batch (source = provider)
                                                     │
                                  Batch History: reconcile gross / fees / deposit, two sign-offs, finalize
```

## What's shared (provider-agnostic)

| Piece | Where |
|---|---|
| Normalised gift shape (`GiftRecord`), provider interfaces | `services/giving/types.ts` |
| Review queue, one row per gift, with dedupe, refund tracking and the raw payload | `external_transactions` table |
| Remembered payer → giver links | `giver_external_ids` |
| Remembered provider fund → SafeTrack fund | `external_fund_map` |
| Staging entry points | `stage_external_transactions` (browser: admin/treasurer only) and `stage_external_transactions_server` (service role, for webhooks) |
| Posting: one atomic batch per group, giver/fund choices applied in the same transaction | `post_external_batch` |
| Matching order: envelope # → remembered link → provider ID on giver → email → unique name | `services/giving/matching.ts` |
| Import / review UI | `components/GivingImport.tsx` (route `#/online-giving`) |
| Reconciliation panel (gross, fees, expected deposit, refunds) | `components/BatchHistory.tsx` |

Payment methods added: `card`, `bank_debit`, `online`. Batch source added: `stripe`.

## Rules the pipeline enforces

- A gift is posted at most once: `donation_id` is unique and posting checks it.
- Only `succeeded` gifts post. Pending gifts wait in the queue, and the next import updates their status.
- A refund that shows up after a gift was posted is recorded (`status = refunded`). The import screen and the batch's reconciliation panel flag it. The posted gift itself is never changed silently.
- Deleting a donation (or a whole open batch) puts its gifts back in the queue.
- Ignoring a gift is audited.
- Gifts are recorded at the **gross** amount, which is what gets receipted. Fees are stored per gift, and the batch shows the expected net bank deposit so the second person can reconcile against the bank.
- Offline gifts that Pushpay merely records (cash, cheque, "Recorded …", Batch Entry, Gift Entry) are skipped. They're counted in in-person batches instead, so nothing is double-counted.

## Pushpay adapter

`services/giving/providers/pushpay.ts`. Two export styles are supported:

- **Envelope report** (`Envelope #, Amount, Date, Fund, Ignore`). Gifts match the Giver Registry directly by envelope number. `Ignore` is read as Pushpay's giver ID and remembered. If the file shows that column changing from gift to gift for the same envelope, it's used as the gift ID instead. This report has no fees, so the expected deposit equals the gross amount.
- **Transactions export**: Transactions → set the period → Apply Filter → Export → **to CSV (Legacy)**.

Pushpay doesn't publish a fixed column list, so the adapter:

- recognises columns by name, using an alias list per field (e.g. `Payment ID`/`Transaction ID`, `Fund Name`/`Fund`, `Payment Type`/`Payment Method`, `Mobile Number`);
- lets the user remap any column on the import screen;
- auto-detects day/month order, with a manual override;
- builds a stable synthetic ID when the file has no payment ID, so re-importing is still safe.

Once a real Pushpay export is checked, its exact headers go in `tests/fixtures/pushpay-sample.csv`. The unit tests (`npm run test:unit`) use that fixture.

## e-Transfer adapter

`services/giving/providers/etransfer.ts` is a **document** provider: one Interac deposit notification email per gift. e-Transfers post as their own `e_transfer` batches, grouped by week (Monday–Sunday) by default.

**What it accepts:**
- `.eml` files, saved from Gmail (⋮ → Download message) or Outlook;
- `.mbox` exports;
- email text pasted into the screen, one email or several.

Forwarded emails work too: the parser uses the original Interac date and sender, not the forward's.

**What it reads, by label and phrase (English and French):**
- the sender's name (ALL-CAPS names are converted to Title Case);
- the sender's email: from the body, the sender label, or Reply-To;
- the amount (`$1,100.00` or `1 250,50 $`);
- the message/memo;
- the reference number, which is the gift ID used for dedupe;
- the date, from the email's Date header.

**What it skips:** money requests, reminders, cancellations and expiry notices.

**Warning:** an email that doesn't show `notify@payments.interac.ca` gets a warning. Spoofed "you've been paid" emails exist, and the bank statement is the final check.

**Matching:**
- an envelope # in the memo (`env 100`, `Envelope #45`, `enveloppe no 205`, or just `101`) matches the giver directly;
- otherwise the sender's email matches the giver's e-Transfer ID or email;
- otherwise the name, if exactly one giver has it.

**Funds:** a fund named in the memo is picked per gift. Otherwise the gift defaults to General, flagged as a guess.

**Learning:** posting records the sender's email in the giver's first free e-Transfer ID slot (migration 13), so the next gift from them matches automatically.

**Planned automatic feed:**
1. The church adds a forwarding rule from the mailbox that receives Interac notifications to a per-church inbound address. Cloudflare Email Routing → Worker, or Postmark/Mailgun inbound, all work.
2. A webhook Edge Function parses each forwarded email with the same `parseInteracEmail()` (postal-mime runs in Deno).
3. It verifies the original sender is Interac.
4. It calls `stage_external_transactions_server(church, 'e_transfer', rows)`. Gifts then wait on the review screen with nothing to upload.

## Adding the Stripe module (planned)

The Stripe module is a **feed** provider: gifts arrive by webhook, not by file upload.

1. **Collect gifts.** Use Stripe Checkout or Payment Element on a church giving page.
   - Use Stripe Connect, so each church is a connected account and funds settle to the church directly.
   - Store the fund in the PaymentIntent metadata (`fund_id`).
   - Store the payer in the Customer (`customer.id` becomes `payer_external_id`).
2. **Webhook Edge Function** `stripe-webhook`:
   - Verify the signature.
   - On `charge.succeeded` / `payment_intent.succeeded`: normalise to the row shape below and call `stage_external_transactions_server(church_id, 'stripe', rows)`.
   - On `charge.refunded`: send the same `external_id` with `status: 'refunded'`. Staging updates it, and posted gifts are flagged.
   - On `payout.paid`: optionally restage the payout's charges with `deposit_ref = payout.id`, so the review screen groups by bank deposit.

   Row shape:

   | Field | Value |
   |---|---|
   | `external_id` | charge id |
   | `gift_date` | |
   | `amount` | |
   | `fee` | `balance_transaction.fee` |
   | `payment_method` | `card` or `bank_debit` (ACSS/ACH) |
   | `status` | |
   | `payer_external_id` | customer id |
   | `payer_name` | |
   | `payer_email` | |
   | `fund_key` | the metadata `fund_id`, so the fund map resolves it with no review |
   | `deposit_ref` | payout id |
   | `raw` | the event |
3. **Register the provider:** add a `FeedProvider` with `id: 'stripe'` to `services/giving/providers/index.ts`. The Online Giving screen then shows the Stripe queue: no upload box, the same review and post flow.
4. **Optional auto-post.** Because Stripe gifts carry our own giver and fund IDs, they could skip review and be posted to a daily batch automatically. A server-side job would call `post_external_batch` as a service user. The batch still needs two-person finalization.

Nothing in the schema, matching, posting or controls changes when Pushpay is retired: stop uploading, and the Stripe queue takes over.
