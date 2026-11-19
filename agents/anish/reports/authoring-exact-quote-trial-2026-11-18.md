# Exact quote trial, November 18

All six frozen cases ran on `d87d59d` after exact-source commerce, engine, and contracts CI passed. See the [trial definition](../../../docs/authoring-exact-quote-trial-2026-11-18.md).

| Case | Task ID | Outcome | Latency (ms) | API cost |
| --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-membership-r18` | `01M7R6GV18CY4HR73KH20HRTDF` | Review ready | 10,278 | $0.009380 |
| `pier-variance-membership-r18` | `01M7R6H7RCHF36HJHJ390X8Q1J` | Review ready | 21,598 | $0.018486 |
| `clearance-1-membership-r18` | `01M7R6HYP86QQ8Q7PD00RHP77S` | Invalid record field | 16,250 | $0.015603 |
| `badge-zone-1-membership-r18` | `01M7R6JFQWSBK00C7RF88CC4V9` | Missing Boolean operand | 11,286 | $0.014597 |
| `category-clear-1-membership-r18` | `01M7R6JXS0JDZ3VNC54CQJ83EH` | Review ready | 10,400 | $0.007463 |
| `nights-1-membership-r18` | `01M7R6KANC4XSCBW2XEGKD7M9P` | False accept: night zero | 14,059 | $0.015359 |

Three of six tasks reached buyer review readiness. All final drafts had verified source quotes, including nights. No task needed the new indexed quote feedback. The regression test covers that repair path. Nights returned verdict 1 for night zero and failed the hidden oracle. Clearance and badge-zone remained invalid after repair. Category passed, including the hidden duplicate-line case.

The six tasks used ten distinct provider calls and all six reservations settled. The cohort cost $0.080888. Campaign attributable API usage is $1.262147. Median task latency was 12,672.5 ms. There were no Bot reviews, approvals, compiles, proofs, or Arc sends in this cohort.

The merged source also passed 68 focused API tests for callback failure, queued-task replay and compile gates, and 21 runner tests for Arc and recovery. A separate read-only RPC probe confirmed chain ID 5042002 and positive balances for both existing testnet wallets. Balances must be checked again against the actual bounty and fees before the final attempt. Public and Bot gates remain open.
