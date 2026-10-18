-- MPP payments audit log.
--
-- What is NEVER stored here (docs/NOTES.md §8):
--   - MPP_SECRET_KEY
--   - the `Authorization: Payment` / `Payment-Authorization: Payment` headers
--   - the `Payment-Receipt` header
--   - raw error messages (they may contain payment data)
-- We log stable references: Challenge id, transaction hash,
-- payer DID, normalized error code.

pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists payments (
  -- The Challenge id is the natural key: it is HMAC-bound to its
  -- parameters. This is what makes writes idempotent.
  --
  -- ⚠️ An id does NOT identify an HTTP request. Since the id is a pure
  -- function of (realm, method, intent, request, expires, digest, opaque),
  -- two identical requests issued within the same millisecond get the SAME
  -- id — measured: 19 collisions out of 50 rapid requests. Hence `occurrences`.
  challenge_id  text primary key,
  realm         text    not null,
  method        text    not null,
  intent        text    not null,
  -- Route, extracted from `opaque` (_mppx_scope) when mppx puts it there.
  route         text,
  -- Base units, stored as TEXT: a bigint does not always fit in SQLite's
  -- REAL, and we want no floating-point conversion.
  amount        text    not null,
  currency      text    not null,
  recipient     text,
  chain_id      integer,
  status        text    not null
                check (status in ('challenged', 'success', 'failed')),
  -- Reference on the payment network (transaction hash). Comes from the Receipt.
  reference     text,
  -- Payer identity: DID did:pkh:eip155:<chain>:0x…
  payer         text,
  -- Normalized MPP error code (e.g. "verification-failed"), never the message.
  error_code    text,
  -- Number of times this Challenge was issued. Without this counter,
  -- reconciliation underestimates traffic because of id collisions.
  occurrences   integer not null default 1,
  created_at    text    not null,
  updated_at    text    not null
);

create index if not exists payments_status_idx  on payments (status);
create index if not exists payments_created_idx on payments (created_at);

-- Reconciliation: how much was offered, collected, refused.
create view if not exists ledger_reconciliation as
select
  status,
  count(*)                                    as entries,
  sum(occurrences)                            as occurrences,
  sum(cast(amount as integer) * occurrences)  as total_base_units,
  min(created_at)                 as first_at,
  max(updated_at)                 as last_at
from payments
group by status;

-- Challenges issued that went nowhere: neither collected nor refused.
-- This is the normal case (a client may never pay), but an abnormal volume
-- signals a client-side problem or a badly calibrated price.
create view if not exists ledger_unsettled as
select challenge_id, route, amount, currency, created_at
from payments
where status = 'challenged'
order by created_at;
