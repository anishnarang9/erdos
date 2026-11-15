# commerce (workstream 3)

Agent-to-agent commerce for proof-gated payments. The plan is [COMMERCE-IMPLEMENTATION.md](../agents/current%20plan/COMMERCE-IMPLEMENTATION.md).

| Package | Contents | Contract |
| --- | --- | --- |
| `sdk` | Byte codec (engine wire format) and the viem chain adapter. The chain ABI is SIMULATED until settlement publishes the real one. | [sdk/CONTRACT.md](sdk/CONTRACT.md) |
| `api` | HTTP JSON API skeleton: storage, auth, idempotency and revision checks | [api/CONTRACT.md](api/CONTRACT.md) |

## Run

```sh
cd commerce
corepack enable            # or prefix each pnpm command with: corepack pnpm@10.34.9
pnpm install
pnpm typecheck
pnpm test
```

You need Node 22.13 or newer (`node:sqlite`). Chain tests start a local anvil from the `@foundry-rs/anvil` npm package. If anvil cannot start, they are skipped and the reason is printed.

Anything labelled **SIMULATED** (stub contracts, mock verifier, plan validator) is a stand-in until the engine and settlement workstreams deliver the real thing.
