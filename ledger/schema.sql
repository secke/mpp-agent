-- Journal d'audit des paiements MPP.
--
-- Ce qui N'EST JAMAIS stocké ici (docs/NOTES.md §8) :
--   - MPP_SECRET_KEY
--   - les en-têtes `Authorization: Payment` / `Payment-Authorization: Payment`
--   - l'en-tête `Payment-Receipt`
--   - les messages d'erreur bruts (ils peuvent contenir des données de paiement)
-- On journalise des références stables : id de Challenge, hash de transaction,
-- DID du payeur, code d'erreur normalisé.

pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists payments (
  -- L'id de Challenge est la clé naturelle : il est lié par HMAC à ses
  -- paramètres. C'est ce qui rend l'écriture idempotente.
  --
  -- ⚠️ Un id ne vaut PAS pour une requête HTTP. L'id étant une fonction pure
  -- de (realm, method, intent, request, expires, digest, opaque), deux
  -- requêtes identiques émises dans la même milliseconde reçoivent le MÊME
  -- id — mesuré : 19 collisions sur 50 requêtes rapides. D'où `occurrences`.
  challenge_id  text primary key,
  realm         text    not null,
  method        text    not null,
  intent        text    not null,
  -- Route, extraite de `opaque` (_mppx_scope) quand mppx l'y place.
  route         text,
  -- Unités de base, stockées en TEXTE : un bigint ne tient pas toujours
  -- dans le REAL de SQLite, et on ne veut aucune conversion flottante.
  amount        text    not null,
  currency      text    not null,
  recipient     text,
  chain_id      integer,
  status        text    not null
                check (status in ('challenged', 'success', 'failed')),
  -- Référence côté réseau de paiement (hash de transaction). Vient du Receipt.
  reference     text,
  -- Identité du payeur : DID did:pkh:eip155:<chain>:0x…
  payer         text,
  -- Code d'erreur MPP normalisé (ex. « verification-failed »), jamais le message.
  error_code    text,
  -- Nombre de fois que ce Challenge a été émis. Sans ce compteur, la
  -- réconciliation sous-estime le trafic à cause des collisions d'id.
  occurrences   integer not null default 1,
  created_at    text    not null,
  updated_at    text    not null
);

create index if not exists payments_status_idx  on payments (status);
create index if not exists payments_created_idx on payments (created_at);

-- Réconciliation : combien a été proposé, encaissé, refusé.
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

-- Challenges émis restés sans suite : ni encaissés, ni refusés.
-- C'est le cas normal (un client peut ne jamais payer), mais un volume
-- anormal signale un problème côté client ou un prix mal calibré.
create view if not exists ledger_unsettled as
select challenge_id, route, amount, currency, created_at
from payments
where status = 'challenged'
order by created_at;
