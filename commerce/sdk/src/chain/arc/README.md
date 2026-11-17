# `arc`: client for the deployed settlement contracts

`import { arc } from "@ubc26/sdk"`. It talks to Nick's contracts on Arc Testnet (chain 5042002): the patched AgenticCommerce core (the escrow), the SettlementHook (hook and evaluator) and the RISC Zero verifier. Addresses and limits come from `arc-testnet.json`; ABIs from `abi/*.json`. The full API is in [INTERFACE.md](INTERFACE.md).

The module never sees a private key. It builds transaction requests, and `sendTx` hands them to a viem `WalletClient` that you create. Everything is browser-safe.

## Set-up

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { arc } from "@ubc26/sdk";

const d = arc.ARC_TESTNET; // validated at load
const pc = createPublicClient({ transport: http(d.rpcUrl) });
await arc.verifyDeployment(pc, d); // once at start-up: chain ID, hook immutables, whitelist

const wallet = createWalletClient({ account, transport: http(d.rpcUrl) }); // your account, your key handling
```

## Poster: four transactions, in order

```ts
const now = await arc.latestTimestamp(pc);
const p = arc.posterTxRequests(d, {
  provider: solverAddress,
  expiredAt: now + 3600n, // must be > now + 300 at createJob and >= now + 600 when fund lands
  description: "job",
  budget: 25_000_000n, // 25 USDC: 6-decimal units
  imageId, rulesHash, referenceHash,
});
const { receipt } = await arc.sendTx(pc, wallet, p.createJob);
const jobId = arc.jobIdFromCreateReceipt(d, receipt);
await arc.sendTx(pc, wallet, p.setBudget(jobId)); // client only
await arc.sendTx(pc, wallet, p.approve); // exactly the budget
const pre = await arc.preflightFund(pc, d, { jobId, poster: account.address, imageId, rulesHash, referenceHash, budget: 25_000_000n });
if (pre.ok) await arc.sendTx(pc, wallet, p.fund(jobId));
```

## Solver: submit, then release

```ts
const job = await arc.readJob(pc, d, jobId);
const terms = await arc.readTerms(pc, d, jobId);
const context = arc.contextForJob(d, job, terms); // 169 bytes; equals hook.contextOf(jobId)
// ... prove against `context`; get envelope (Uint8Array), seal (Hex), keyCommitment (Hex) ...

const pre = await arc.preflightSubmit(pc, d, { jobId, provider: account.address, envelope, seal, keyCommitment });
if (!pre.ok) throw new Error(pre.reason); // pre.revertName: InvalidJob, NotProvider, VerificationFailed, ...
await arc.sendTx(pc, wallet, arc.submitTx(d, jobId, envelope, seal, keyCommitment)); // goes to the core

const sub = await arc.readSubmission(pc, d, jobId);
if (!arc.releaseKeyMatches(context, key, sub.keyCommitment)) throw new Error("wrong key"); // local check
const rel = await arc.preflightRelease(pc, d, { jobId, provider: account.address }); // dummy key, expects WrongKey
if (rel.ok) await arc.sendTx(pc, wallet, arc.releaseTx(d, jobId, key)); // goes to the hook
```

Refund, by anyone, once `block.timestamp >= expiredAt`: `preflightRefund`, then `sendTx(pc, wallet, arc.claimRefundTx(d, jobId))`.

## Events

```ts
const events = await arc.getSettlementEvents(pc, d, d.deployBlock); // pages in windows of <= 10,000 blocks
for (const e of events) if (e.name === "KeyReleased") use(e.args.jobId, e.args.key); // typed per event
```

## Rules the module enforces

- **Release key.** The real key never goes into `eth_call`, `eth_estimateGas` or `eth_fillTransaction`. `preflightRelease` sends a dummy key and treats the revert `WrongKey` as success; it throws if the "dummy" key matches the accepted commitment. `sendTx` signs a `release` locally and sends it raw with a fixed gas limit. A release that lands after expiry reverts and still publishes the key, so `preflightRelease` fails within 120 s of expiry.
- **Fee floor.** `sendTx` uses `arcFees`: `maxFeePerGas` is at least 20 gwei. Arc drops anything lower without a receipt.
- **Explicit gas.** `submit` gets `submitGasLimit` (calldata floor plus 1,000,000), because a seal with broken proof bytes burns all the gas it is given. `release` gets `DEFAULT_RELEASE_GAS`. Other requests get an estimate plus 25%.
- **USDC is 6 decimals** through the ERC-20 interface. Every request has `value: 0n`; gas is the same balance in 18 decimals and is never mixed in.
- **Reverts are named.** Custom errors of the core, the hook and the verifier decode into `revertName` on preflight results and on `ArcError("reverted")`.
- **Unknown job IDs.** The core returns an all-zero struct; `readJob` throws `ArcError("not_found")`. `readTerms` and `readSubmission` return zeros with `frozen: false` and `submitted: false`.

## Tests

- `corepack pnpm exec vitest run` (default suite): `test/unit/arc-pure.test.ts` and `test/unit/arc-rpc.test.ts`. No network.
- `corepack pnpm test:arc`: `test/live/arc-readonly.test.ts` against the manifest RPC. Read-only: no keys, no transactions.
