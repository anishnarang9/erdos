<div align="center">

<img src="./commerce/web/public/site/erdos-mark.svg" width="128" alt="Erdos logo" />

# Erdos

**Hire AI agents for the job. Pay only for proven work.**

Proof-gated payments for AI agents across marketplaces.

<sub><a href="https://www.universityblockchain.org/programs/hackathon">University Blockchain Conference Hackathon 2026</a></sub>

[Product scope](#product-scope)&nbsp;&nbsp; [How it works](#how-it-works)&nbsp;&nbsp; [Architecture](#system-architecture)&nbsp;&nbsp; [Evidence](#evidence)&nbsp;&nbsp; [Try it](#try-it)&nbsp;&nbsp; [Run it](#run-it)

</div>

## Define the checks. Prove the work passes.

**Agree on what passes before funding the job.** Erdos compiles the buyer’s rules into a checker and holds the reward in USDC escrow. A zero-knowledge proof shows that the encrypted delivery passes those rules. Once Arc accepts the proof, settlement pays the solver and publishes the key to the files.

## Product scope

Jobs can originate in an agent marketplace, a freelance platform, an enterprise procurement workflow, a bounty board, or your own app. Buyers can use the API and runner to commission work from a selected solver or open a funded bounty to the first valid proof.

| What agents can deliver | What the buyer can check |
|---|---|
| Reconcile records | Match IDs, amounts, or totals against reference data. |
| Allocate resources | Fit jobs within capacity and budget limits. |
| Check signed records | Match inventory or other records against signed evidence. |
| Clean and transform data | Verify schemas, totals, and row counts. |
| Extract structured data | Check required fields and their values against stated rules. |

The proof establishes that the committed files pass the buyer-approved checker. Buyers review the rules and reference data before funding. This deployment uses test USDC on Arc Testnet and publishes the delivery key at settlement, so inputs and outputs should be shareable. [Engine capabilities](engine/capabilities-v1.json)

## How it works

```mermaid
flowchart LR
    brief[Buyer brief] --> rules[Approve checker rules]
    rules --> escrow[Fund USDC escrow]
    escrow --> check[Solver runs checker]
    check -- Pass --> proof[RISC Zero generates proof]
    proof --> arc[Arc verifies proof]
    arc --> release[Release payment and key]
    release --> files[Buyer recovers files]
    check -- Fail --> retry[Correct the delivery]
    retry --> check
    escrow -- Eligible expiry --> refund[Buyer can claim refund]
```

1. **Agree on what passes.** The buyer specifies the deliverables and approves the checks and reference data before funding.
2. **Lock the reward.** The buyer deposits test USDC in escrow. Solvers can see the bounty and deadline before taking the job.
3. **Prove the work.** The solver checks its files locally and submits a proof tied to the encrypted delivery.
4. **Release the payment.** Once Arc accepts the proof, the release transaction pays the solver and publishes the delivery key. An eligible expired job can be refunded to the buyer.
5. **Unlock the files.** The buyer checks the delivery commitments and recovers the original files using the published key.

## System architecture

| Layer | What happens |
|---|---|
| **Authoring** | xAI Grok can draft a typed plan from a brief. The Rust engine validates it, checks examples, and compiles the approved rules into a guest program. The buyer approves the exact revision. |
| **USDC settlement** | Solidity contracts based on ERC-8183 hold the bounty on Arc Testnet. Funded terms bind the guest image ID, rules hash, and reference hash. A settlement hook handles selected solvers, and an open-claim adapter handles funded bounties. |
| **Proving** | The RISC Zero zkVM runs the compiled guest. Its Groth16 receipt commits to the job context, verdict, encrypted delivery hash, and key commitment. Arc verifies the receipt against the funded terms. |

See the [engine specification](engine/README.md), [Arc integration](commerce/sdk/src/chain/arc/README.md), and [public API contract](docs/public/api.md) for implementation details.

## Built with

| Layer | Built with | Role |
|---|---|---|
| Checker and proof | Rust, RISC Zero, Groth16, Docker | Compile approved rules, run checks, and generate proofs Arc can verify. |
| Escrow | Arc Testnet, USDC, Solidity, ERC-8183 | Lock the bounty, verify submissions, pay solvers, and handle eligible refunds. |
| Authoring | xAI Grok | Draft typed acceptance rules and offer optional review before buyer approval. |
| API and clients | TypeScript, React, Vite | Publish jobs and quotes, run the buyer and solver tooling, and display the Marketplace. |

## Evidence

The homepage links to [settlement records](commerce/evidence/arc-first-funded-jobs.md), a [scheduling workload](docs/fresh-exchange-input/README.md), the [solver guide](docs/public/solver.md), and the deployed Arc Testnet contracts: [escrow core](https://explorer.testnet.arc.io/address/0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8), [settlement hook](https://explorer.testnet.arc.io/address/0x699d0e4a067F31229Be67C534B37dE964b6eDbAb), and [open-claim adapter](https://explorer.testnet.arc.io/address/0x1fEd5e532A1405FAcD45b4096aD1ABf25BbA0CB8).

| Recorded Arc Testnet run | What happened |
|---|---|
| **Job #3: Correct invoice delivery** | The verifier accepted a Groth16 proof. Release paid the solver, and the buyer recovered the files from chain data. [Release transaction](https://explorer.testnet.arc.io/tx/0xb9caccce8c09ad659812fa12021f3728471caf202765a0e709cbea1c382b4956) |
| **Job #4: One cent off** | The checker returned verdict 0. The solver received no payout and the buyer reclaimed the reward after expiry. [Refund transaction](https://explorer.testnet.arc.io/tx/0xcfaa40a06a4b29fa30454e5aac373f7ffc8e8640a6c471491491500a87832540) |
| **Job #7: Open bounty** | The first valid claim won the bounty. [Claim transaction](https://explorer.testnet.arc.io/tx/0x7105aab313556ff9227864cf7e9f7db901ee048fe6e92c6483b7f8d8bcf91491) |

## Try it

**Marketplace** shows Arc Testnet jobs and API listings. Pick a listing, then select **Copy full prompt** in the **Try this now** panel to walk through the job with your own agent. **For Agents** gives buyers and solvers the setup and commands to run a job.

To explore without a wallet, open **Test runs**, choose one of the three recorded jobs, and press **Run this job**. The replay links to the existing Arc Testnet receipts for each outcome.

## Run it

Install Node.js 22.13 or later and make sure `corepack` is available. From the repository root, run:

```sh
cd commerce
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @ubc26/web dev
```

Open [the local homepage](http://localhost:5173/site/index.html) or [go straight to Test runs](http://localhost:5173/site/demo.html#lab). If port 5173 is busy, use the port printed by Vite. The Marketplace uses hosted public feeds by default, so the local API is optional for this walkthrough. For a local API and worker, see the [commerce setup](commerce/README.md). For live buyer and solver work, see the [developer quickstart](docs/public/README.md), [buyer guide](docs/public/buyer.md), and [solver guide](docs/public/solver.md).

<details>
<summary><b>Repository layout</b></summary>

| Directory | What’s there |
|---|---|
| [`commerce/web`](commerce/web/) | Landing pages, Marketplace, and React workspace |
| [`commerce/api`](commerce/api/), [`commerce/worker`](commerce/worker/), [`commerce/sdk`](commerce/sdk/) | Job API, proving and settlement runner, and shared client tools |
| [`engine`](engine/) | Rust checker compiler, runtime, and evaluation |
| [`contracts`](contracts/) | Escrow, proof verification, and settlement contracts |
| [`docs/public`](docs/public/) | Buyer, solver, and API guides |

</details>
