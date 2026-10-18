# Configuration and network guard

**Phase 1** · Code: `server/config.ts` · Tests: `tests/server/config.test.ts`

## What it does

Loads the configuration from the environment, validates it strictly, and
**refuses to start** if anything is off. No silent default on anything that
touches money.

## Why

The `mppx` SDK default is the **main network** (see
[`NOTES.md` §4.1](../NOTES.md)). A forgotten variable must not result in a
real payment. The project rule is "testnet only": we make it mechanical
rather than declarative.

## Variables

| Variable | Required | Default | Validation |
|---|---|---|---|
| `MPP_SECRET_KEY` | ✅ | — | ≥ 32 bytes (enforced by `mppx`) |
| `MPP_RECIPIENT` | ✅ | — | `0x` address, 40 hex characters |
| `MPP_REALM` | — | `localhost` | — |
| `MPP_SEARCH_PRICE` | — | `0.50` | readable amount, ≤ 6 decimals |
| `PORT` | — | `8787` | integer 1–65535 |
| `MPP_NETWORK` | — | `testnet` | **must be `testnet`** |

Template: [`.env.example`](../../.env.example). `.env` is gitignored.

## Usage

```bash
cp .env.example .env
openssl rand -base64 32                      # -> MPP_SECRET_KEY
npx mppx account create --account main
npx mppx account fund --network testnet
npx mppx account view --account main         # -> MPP_RECIPIENT
npm run dev
```

`npm run dev` goes through `node --env-file=.env`: native since Node 20.6,
so there is no `dotenv` dependency.

## Details that matter

- **`MPP_NETWORK` is a hard stop.** Any value other than `testnet` makes
  `loadConfig` fail, with an explicit message. There is no code path that
  switches to mainnet.
- **The price is validated by the regular expression** `^\d+(\.\d{1,6})?$`:
  scientific notation (`1e-3`) and amounts with more than 6 decimals are
  rejected, because `mppx` converts to base units with 6 decimals and a
  silent rounding on an amount is a loss of money.
- **The secret length is checked by us *and* by `mppx`.** We double the check
  to produce a clear error when the config is read, rather than at the first
  Challenge.

## Tests

6 tests: valid configuration, refusal of `mainnet`, refusal of a short secret,
refusal of a malformed address, refusal of a malformed or over-precise price,
refusal of a missing required variable.
