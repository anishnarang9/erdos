# Open-claim Arc run plan

2026-11-16 — Anish. The current Goal authorizes this plan, checkpoint commits, and pushes to PR #7.

The integration branch contains the contract correction (`3f0ecbf`), protected solver signing (`843f842`), and five-step buyer helper (`e29da7d`). The signed buyer path now requires a deployment-pin check. These helpers have unit checks; the earlier real-proof local acceptance used unlocked synthetic accounts at source `0cce487`. Preserve the selected-provider flow.

1. Wire the protected buyer and solver helpers to the verified live manifest and operator commands for preview, funding, proving, claim, release, recovery, and refund.
2. Base expiry on the 1,053-second measured proof. Allow 1,800 seconds for proving, 60 seconds for claim, and 600 seconds for release and confirmations. Use a 3,600-second proposed lifetime.
3. Recheck Circle Gateway capabilities. Test its payment challenge, signed authorization, paid result, and replay. Treat Gateway batch acceptance and later chain settlement as distinct evidence.
4. Run focused regressions, workspace checks, real-engine API checks, and relevant contract checks. Integrate published adapter changes. Push and inspect PR #7 CI at the combined SHA.
5. After verified deployment and explicit account limits arrive, execute one fresh funded proof with one prover. Record claim, release, gas-adjusted USDC balances, byte-exact recovery, a rejected claim, and a separate expiry refund.

Missing external inputs do not stop independent tests. Live signing requires approved public addresses, protected keystore access, exact bounty and gas limits, and separate Circle service-payment limits.
Never put a key, password, payment signature, or signed release transaction in a report or prompt.
