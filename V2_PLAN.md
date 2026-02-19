# Zeruva Backend v2 — The Great Expedition

Implement a new rounds/ships/entries system.

## Tables
- rounds
- round_entries
- user_credits (or reuse payment_intents/credits)

## Endpoints (draft)
- GET /api/v2/round/current
- POST /api/v2/round/enter (choose ship + amount)
- POST /api/v2/round/buy-entries-intent (on-chain payment)
- POST /api/v2/round/settle (cron/admin/auto)

## Notes
Keep v1 endpoints intact in v1 backend repo; v2 backend lives in separate repo/folder.
