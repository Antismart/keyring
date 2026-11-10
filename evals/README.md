# Evals

Reproducible transcripts of an agent operating through Keyring.

## Status: not yet produced

An eval here requires the MCP server wired to a deployed testnet contract
(Gate F). Producing a transcript against the mock signer would demonstrate the
policy engine but would not show the workflow the project claims, so it is
deliberately absent rather than approximated.

## Planned transcripts

The demo is one coherent workflow (CLAUDE.md §13):

| # | Transcript | Shows |
|---|---|---|
| 1 | `01-setup.md` | Owner creates a Keyring, registers an agent with limits |
| 2 | `02-allowed-payment.md` | Agent makes a payment within policy; destination-chain tx verified |
| 3 | `03-refusal.md` | Agent attempts a disallowed payment, receives a precise structured refusal |
| 4 | `04-revocation.md` | Owner disables the agent; the next request fails |
| 5 | `05-audit.md` | NEP-297 event history showing every decision |

Each transcript must record the contract account, the block height, the request
ids, and the destination-chain transaction hash, so a reader can verify it
independently rather than taking the transcript's word.

Transcript 3 is as important as transcript 2: the refusal is the product.
