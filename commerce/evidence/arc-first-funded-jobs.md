# First funded jobs on Arc testnet (2026-11-15)

These are real transactions on Nick's deployed contracts: core proxy `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8` and SettlementHook `0x699d0e4a067F31229Be67C534B37dE964b6eDbAb`, on chain 5042002. The runbook is `commerce/worker/scripts/first-funded-job.ts`: an in-process API, the real engine in WSL2, real Groth16 proofs, and Anish's reconciliation plan with the ledger reference.

| Role | Address |
| --- | --- |
| Poster (buyer) | `0x389ADc17dE4353dBafD97387ef609EB97694808C` |
| Solver (worker) | `0x55B0984A8600548E42D3F8b7a53D881Dbe4ee9f7` |

Both accounts are new testnet accounts, funded with 20 USDC each from Circle's faucet. Their keys exist only in a gitignored `commerce/worker/.env`.

## Job 1: correct delivery, paid

Image ID `0x57eb5af8…d62d`, rulesHash `0x9d80733e…3457`, referenceHash `0x49a43354…07dd`, budget 0.01 USDC (10000 units).

| Step | Transaction | Event |
| --- | --- | --- |
| createJob | [0xf5c8b255…661e](https://explorer.testnet.arc.io/tx/0xf5c8b255832ad87c29b81e3e217cc1c458617afc37705c7c2a4144ac5959661e) | `JobCreated` (job 1, the first job on the core) |
| setBudget | [0x9e104ee7…ce8b](https://explorer.testnet.arc.io/tx/0x9e104ee7c34d2532f044687b929a109a9a3cc66b339f539c566ce6e54972ce8b) | `BudgetSet` 10000 |
| approve | [0xe5f3ca45…e175](https://explorer.testnet.arc.io/tx/0xe5f3ca4541f5ddb64ea9c3d99781de8cb8ab7fb8ee4c1308d89594c9708ee175) | USDC allowance equal to the budget |
| fund | [0xe7b1e230…6e1e](https://explorer.testnet.arc.io/tx/0xe7b1e230180cc3ce7eedf6031c04f24f273e364cadf14192e0e2fb528b4c6e1e) | `JobFunded` and `TermsFrozen` |
| submit | [0x5dc711b3…d84a](https://explorer.testnet.arc.io/tx/0x5dc711b36140d9562461c710077fe6d7b336db5a5d0e00c7fbe739fedbdfd84a) | `JobSubmitted` and `ProofAccepted`: the verifier accepted the Groth16 proof |
| release | [0xbaf7bbd4…3725](https://explorer.testnet.arc.io/tx/0xbaf7bbd496cc20e34cde3820f4c2711ff2f10656b6cd7b402fedb32459ce3725) | `JobCompleted`, `PaymentReleased` (10000 to the Solver), `KeyReleased` |

- **Proof:** 126.4 s on WSL2 (24 cores), 812,683 guest cycles, verdict 1. The worker took the context from `hook.contextOf(1)`.
- **Buyer delivery** (`scripts/verify-delivery.ts 1`, public chain data only): sha256(envelope from the submit calldata) equals `ProofAccepted.envelopeHash`. The released key opens `keyCommitment`. The decrypted `result.json` (sha256 `0x5a60df24…27c8`) and `report.txt` (`0xf3130dea…982c`) equal the Solver's output byte for byte.
- **Final state:** `Completed`.

## Job 2: tampered delivery, rejected, refundable

The Solver changed one amount by one cent.

| Step | Transaction | Result |
| --- | --- | --- |
| createJob | [0x1a060962…2b68](https://explorer.testnet.arc.io/tx/0x1a06096277ead5fc4e6c4d4ac5afa52564bc06febc9d68e58c2df93434cb2b68) | job 2 |
| setBudget | [0x8dd6f3c4…5cab](https://explorer.testnet.arc.io/tx/0x8dd6f3c4fa0cae5a6276e0d2cbbed88ebdd804fc14d29a9af0d9311a538f5cab) | |
| approve | [0xca9de36e…51c0](https://explorer.testnet.arc.io/tx/0xca9de36e451bd65582fb8c7da7a5e8a2286579b1b5dd62bd03288053cc8051c0) | |
| fund | [0x5b594d62…b8ce](https://explorer.testnet.arc.io/tx/0x5b594d62ba194fa3ca74e1a2983225b36361a6806c51bd133f306e9d6dbfb8ce) | Funded, terms frozen |

- **Proof:** a real proof with verdict 0 (118.7 s, 812,683 cycles). The worker never submits a verdict-0 proof. Its submit preflight (`eth_call`) shows the chain would reject the proof too: the verifier reverts with `VerificationFailed`.
- **State after the attempt:** `Funded`, with no submission and no key. The escrow stays locked for the Poster.
- **Refund** (`scripts/claim-refund.ts 2`, after expiry): [0xf8bd04d4…2de3](https://explorer.testnet.arc.io/tx/0xf8bd04d4693c7fe21c10c11c8d4887f840fcb1abbb03eab49fa3fc17b0c72de3). `Refunded` and `JobExpired`; the final state is `Expired`. The Poster's balance went from 19.949794 to 19.957926 USDC: the 0.01 USDC refund minus the claim's gas.

## Jobs 3 and 4: the same flow driven from the buyer UI (2026-11-16)

Both jobs were clicked through `commerce/web` with the demo signer and the solver agents. All transactions are on Arc testnet.

**Job 3 (honest solver, paid):** funding txs `0x7cd435ae…f22a2c` (createJob), `0xe557e2e6…d6c51d` (setBudget), `0xc606c3a0…68c0ed` (approve), `0xaf139820…981be0` (fund). Proof 147.7 s, 937,488 cycles, verdict 1. Submit [0x05693a09…abf76c](https://explorer.testnet.arc.io/tx/0x05693a09af7886d83b0c7cdac00b0bd134bfc471be76cc9e7b0abaa704abf76c) (ProofAccepted); release [0xb9caccce…2b4956](https://explorer.testnet.arc.io/tx/0xb9caccce8c09ad659812fa12021f3728471caf202765a0e709cbea1c382b4956). The browser decrypted the delivery from chain data and both commitment checks passed. Recording: `commerce/web/recordings/run-2026-11-16-job3-paid.json`.

**Job 4 (tamper solver `0x53be…ada0`, cheaper quote of 0.009 USDC, selected by the buyer):** funding tx `0x941fd66d…1a696e` (fund). Proof 101.1 s, 937,488 cycles, verdict 0. The submit preflight reverted with `VerificationFailed`, so nothing was sent. The escrow stayed Funded until expiry; the refund was claimed from the UI: `0xcfaa40a0…832540`.
