# Open-claim implementation correction report

2026-11-16 — Native fallback worker, inherited model `gpt-6.1-sol`.

The parent imported the existing adapter and local script from rescue commit `8b9589dff506a3741a7580414a8ad2a0631f8baf`. This worker made narrow corrections after that import. The worker did not recreate the adapter or change its claim and release logic.

## Changed paths

- `contracts/src/OpenClaimAdapter.sol`: the constructor now calls the existing `_checkTokenAndFees()` helper after setting its immutables. Both initial core fees must equal zero. The public ABI remains unchanged.
- `contracts/script/09_DeployOpenClaimLocal.s.sol`: the script checks the active RPC client and node metadata before it starts broadcasting. It requires explicit local opt-in, Anvil, Arc network, chain 5042002 and null fork configuration. It keeps the existing fresh-node, native-token and absent-live-core checks.
- `docs/overnight/implementation-report.md`: this report.

The parent owns test changes, ABI export, final reviews, commits and pushes. This worker did not edit tests, core contracts, tracked deployment manifests or ABI files.

## Local manifest semantics

The script writes the ignored runtime file `contracts/deployments/open-claim-local.json`. Its fields follow `contracts/deployments/OPEN-CLAIM-SCHEMA.md`, with two explicit execution states:

- A dry run writes `status: simulated` and `executionMode: simulated`.
- A broadcast run writes `status: broadcast-pending-confirmation` and `executionMode: broadcast-requested`.

Forge executes the script before it receives broadcast receipts. The file therefore keeps `core.deployBlock`, `adapter.deployTx` and `adapter.deployBlock` null in both states. It keeps all three evidence flags false. Addresses and runtime hashes describe the simulated deployment. The core freeze flag records the checked simulation state. Independent receipt and chain checks must establish a confirmed deployment.

The file includes native USDC, real verifier version and selector, core and implementation wiring, zero fees, adapter roles, proof context domain and exported ABI paths. The script preserves the selected-provider deployment manifest.

## Checks and results

Commands ran from `contracts/` unless stated otherwise. `$ARC_FORGE` denotes the pinned executable at `/Users/anishnarang/.local/share/ubc26/sprints/2026-11-15-core/tools/arc-foundry/forge`, commit `3e95efaeaaaca64d6ac9c1ee988968683dbd0d22`. Calls used `RUST_LOG=error` to suppress unrelated trace-source warnings.

| Command or check | Exit | Result |
| --- | --- | --- |
| `$ARC_FORGE test --network arc --match-path test/openclaim/OpenClaimAdapter.t.sol --match-test 'test_constructorRejectsInitial.*Fee'`, before the correction | 1 | Both parent-written constructor regressions failed because deployment did not revert. |
| Existing script dry run through a loopback proxy reporting client `arc/v1`, before the correction | 0 | Reproduced the missing client check. No transaction broadcast occurred. |
| `$ARC_FORGE test --network arc --match-path 'test/openclaim/*.t.sol'`, after the constructor correction | 0 | 42 adapter tests and six checked-in real-receipt tests passed. Three fuzz tests ran 256 cases each. |
| `OPEN_CLAIM_LOCAL=1 $ARC_FORGE script script/09_DeployOpenClaimLocal.s.sol:DeployOpenClaimLocal --network arc --rpc-url http://127.0.0.1:18545 --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 0 | Final script simulated successfully against active forkless Arc Anvil 1.7.1 and native USDC. |
| Same script through `http://127.0.0.1:19547`, with proxy client `arc/v1` | 1 | Rejected with `active RPC must be Anvil` before broadcasting. |
| Same proxy, with actual Anvil client but a non-null fork URL and block | 1 | Rejected with `forkless Anvil required` before broadcasting. |
| Same direct-node command with `OPEN_CLAIM_LOCAL=0` | 1 | Rejected with `OPEN_CLAIM_LOCAL=1 required` before broadcasting. |
| Python JSON assertions on the generated local manifest | 0 | Checked execution state, null receipt fields, false evidence flags, wiring fields, native token, verifier version, selector and policy. |
| `$ARC_FORGE fmt --check contracts/src/OpenClaimAdapter.sol contracts/script/09_DeployOpenClaimLocal.s.sol`, from the repository root | 0 | Formatting passed. |
| `git diff --check -- contracts/src/OpenClaimAdapter.sol contracts/script/09_DeployOpenClaimLocal.s.sol`, from the repository root | 0 | Whitespace passed. |
| `git check-ignore contracts/deployments/open-claim-local.json`, from the repository root | 0 | The runtime output is ignored. |

The temporary proxy forwarded requests only to the parent's loopback node. It changed RPC metadata to test rejection. It never forwarded to a live endpoint. The worker stopped the proxy after the checks.

## Decoder finding

The pinned Arc Foundry `vm.rpc` returns ABI-encoded values. It does not return raw JSON. A scratch probe established the exact alphabetical object-field layout.

A non-null fork URL changes the fork tuple from static to dynamic. Direct decoding with the forkless layout initially rejected the fork proxy with a memory-allocation panic. The final script checks the fixed-size header first. The same fork proxy then received the intended `forkless Anvil required` rejection. A final direct-node dry run passed after that change.

The node guard deliberately supports the pinned Arc Anvil response schema. A different or malformed schema fails closed. This worker did not test other Anvil releases.

## Worker handoff

No scoped commit or push occurred. This worker did not broadcast, read a wallet, call a live RPC, generate a proof or build a guest. The parent owns the unlocked local broadcast check, independent source reviews and final artifact checks. Checked-in receipt acceptance does not establish a new proof or a live exchange for this corrected adapter.

## Final parent verification and publication

The parent then checked the final source and both exported adapter ABIs at contract checkpoint `3f0ecbf`. The adapter and SDK copies of `OpenClaimAdapter.json` are byte identical. `node contracts/script/check-abi.mjs` matched all five exported ABIs with compiled artifacts. The [standards review](erc8183-compatibility.md) records the ERC-8183 draft gaps: the pinned core uses `fund(uint256,bytes)` while the draft includes an expected-budget argument, the core keeps buyer-only budget authority, and hook data differs. The open-claim adapter is an extension over the frozen core. A Circle Gateway x402 API fee does not directly fund a core bounty.

The parent ran these exact commands from `contracts/`, with `$ARC_FORGE` set to the pinned binary above and `RUST_LOG=error`. The example commands ran from `contracts/examples/`.

| Command | Exit | Result |
| --- | --- | --- |
| `$ARC_FORGE test --network arc --match-path 'test/openclaim/OpenClaimAdapter.t.sol'` | 0 | 42 adversarial adapter tests passed; three fuzz cases ran 256 inputs each. |
| `$ARC_FORGE test --network arc --match-path 'test/openclaim/OpenClaimRealReceipt.t.sol'` | 0 | Six checked-in real-verifier receipt tests passed. |
| `$ARC_FORGE test --network arc` | 0 | Full local Foundry suite: 168 passed, zero failed, one fork-only skip. |
| `$ARC_FORGE fmt --check src/OpenClaimAdapter.sol script/09_DeployOpenClaimLocal.s.sol test/openclaim/OpenClaimAdapter.t.sol test/openclaim/OpenClaimRealReceipt.t.sol` | 0 | Scoped formatting passed. |
| `node contracts/script/check-abi.mjs` from repository root | 0 | Five compiled/exported ABI parity checks passed. |
| `npm test` from `contracts/examples/` | 0 | 16 example tests passed. |
| `npm run typecheck` from `contracts/examples/` | 0 | TypeScript typecheck passed. |
| `git diff --check` from repository root | 0 | No whitespace errors. |

The safe local deployment simulation command and its exit are in the table above. It sent no transaction. The separate [combined local acceptance report](../../agents/anish/reports/open-claim-local-acceptance-2026-11-16.json) records a fresh proof, exact payout, byte recovery and refund; the six receipt checks above used checked-in proofs. An independent Grok 4.7 High read-only review found no concrete P1/P2 issue and reran 48 open-claim tests offline. The [fixed-block Arc preflight](../../agents/anish/reports/open-claim-arc-preflight-2026-11-16.md) records live reads and an unsigned deployment preview. The corrected contract branch was pushed at `3f0ecbf`; its exact interface was sent to the integration chat. No live adapter deployment or wallet operation occurred.
