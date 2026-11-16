# Open-claim Arc run plan

2026-11-16 — Anish. The current Goal authorizes this plan, checkpoint commits, and pushes to PR #7.

Continue from `8b9589d` in `codex/open-escrow-rescue`. The other chat owns contracts and deployment.
Integrate only its published descendant commits after that base. Preserve the selected-provider flow.

1. Add protected local signing for the adapter. Reuse the durable account journal, exact calldata policy, gas reservations, and receipt reconciliation.
2. Complete buyer execution of the five approved calls. Check confirmed receipts, core state, allowance, registration, and the exact budget.
3. Add a live manifest reader and operator commands for preview, funding, proving, claim, release, recovery, and refund.
4. Base expiry on the 1,053-second measured proof. Allow 1,800 seconds for proving, 60 seconds for claim, and 600 seconds for release and confirmations. Use a 3,600-second proposed lifetime.
5. Recheck Circle Gateway capabilities. Test its payment challenge, signed authorization, paid result, and replay. Treat Gateway batch acceptance and later chain settlement as distinct evidence.
6. Run focused regressions, workspace checks, real-engine API checks, and relevant contract checks. Integrate published adapter changes. Push and inspect PR #7 CI at the combined SHA.
7. After verified deployment and explicit account limits arrive, execute one fresh funded proof with one prover. Record claim, release, gas-adjusted USDC balances, byte-exact recovery, a rejected claim, and a separate expiry refund.

Missing external inputs do not stop independent tests. Live signing requires approved public addresses, protected keystore access, exact bounty and gas limits, and separate Circle service-payment limits.
Never put a key, password, payment signature, or signed release transaction in a report or prompt.
