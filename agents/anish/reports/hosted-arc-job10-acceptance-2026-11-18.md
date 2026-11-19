# Independent receipt job on Arc Testnet

[Arc job 10 public record](https://ubc26-159-89-149-133.sslip.io/v1/open-jobs/01M7RE20GNR85VJG5XC1A718DC) shows Completed, released, and solver `0x2e81c7381b498d90c25c1074ade76184b6d5b486`. The buyer and solver used separate wallets and private work directories. Each started with the public guide. The solver found the task through discovery and supplied its own receipt.

## Authoring and approval

The first buyer received HTTP 429 before admission. The service saved that response under the original idempotency key. Two requests with that key created no task, reservation, or provider dispatch. The operator corrected the daily authoring ceiling to $2.552376 to cover prior settled usage and one request reservation. A new independent buyer then started from a new key and work directory.

| Item | Evidence |
| --- | --- |
| Hosted draft | `01M7RE1DE3Q2TMHTRNT2QNJFGB`, one provider dispatch, $0.009896 settled |
| Buyer examples | Seven verdict cases agreed. Two unknown-key cases returned input errors with no verdict. |
| Grok Bot | `01M7RE2J8BFC8043SJPWB9KXDT` passed the exact revision. One malformed request failed before dispatch. |
| Approved revision | `0x84a0a086564220560ff5dbee51dbafbfb0c1717415fd2523f464f4d5f7bb56cc` |
| Compile | `01M7RE37V6BM2PYTXHKBQNCB7R` succeeded |
| Sources | API `4fc9452dbab2de01217d186523e7bcf899a6b4d7`, docs `e872b96cd56a7e62edfaf35b691555c711455694`, runner and engine `0b35d3a5e327144045d04fe45084f6258bb23f3c` |

## Proof and settlement

The solver's receipt passed the local check with verdict 1. The fresh proof also returned verdict 1 after 18m34.015s, including the runner's private recovery check. Proof SHA-256 was `ea178b57e145d56a77834f42fa469c2e8db9663daa2f10046f0e5e0c91307750`. The solver receipt SHA-256 was `3e454c9b45f5db52a29bb27210f06014b987b9ee062c3acaa51d4243fe3af971`.

| Step | Arc block | Transaction |
| --- | ---: | --- |
| Create | 72924286 | `0x9fb9c41cbc6bd765cfda54321bbad1d2625249ec401a20ddd42812fb48766463` |
| Set budget | 72924305 | `0x870d3d3b04886c373beab152212b338204dce2722dc24e57592dd474754e079d` |
| Approve | 72924324 | `0xb1ed903988e48648ca7f5c63f5ffe082e9472da74ddaa69dd9b910f69c193c2d` |
| Fund | 72924343 | `0xd0094744f95b526576ab453507cd033c53f093efc54d35a99901d21197368067` |
| Register | 72924362 | `0x1e4e927f8034f6e34b172f4c96d3dbdf08e6960aa803c59a6a987b60648768ac` |
| Claim | 72930099 | [Receipt](https://explorer.testnet.arc.io/tx/0x003f13d21faf50e9984bddc4d45d560dcddb5f5698d1d5d3fcd4497a372d2546) |
| Release | 72930763 | [Receipt](https://explorer.testnet.arc.io/tx/0xcd2419a5c91f55620c6981eac771121c165d5362bfc77badc5cbf37f58274a10) |

All seven receipts succeeded and matched their block hashes. The release moved 10,000 USDC base units from core to adapter and then to the solver. Native USDC balance changes matched a 0.01 USDC buyer debit and solver credit after gas. The buyer used 0.01336398 testnet USDC in gas. The solver used 0.01249412. The solver reconciled the exact claim and release hashes at nonces 4 and 5. The final runner reported confirmed payment and a reconciled journal.

## Reliability limits

The solver hit public RPC rate limits before the prover started. Its custom read transport used an explorer snapshot for older role logs and live RPC for the tail. This relies on explorer index completeness for the snapshot. The solver resumed the saved claim and release states after their first receipt reads returned no result. The final reconciliation blocked broadcasts.

The service returned intermittent HTTP 503 for open-job detail while its Arc endpoint throttled VPS reads. The operator moved the API's open-claim reads to the independently checked PublicNode endpoint. Readiness passed and six consecutive job detail requests returned 200. This sample does not establish long-term RPC reliability.

The original buyer recovery command failed with a redacted error after confirmed release. The buyer traced it to HTTP 429 during a core role history query. The unmodified pinned runner recovered through QuickNode's public Arc RPC. An independent receipt check passed. It found each ordered item once, with counts 3, 4, and 2 and total 9 of 9. The root audit compared the 148 recovered SDK bytes with the native engine output and the original solver file. All three matched byte for byte. The buyer needed no solver files or wallet to recover the receipt.

Job 10 proves independent completion with RPC workarounds. The published guide alone has yet to reproduce this flow reliably.

The operator independently repeated recovery in a fresh directory with candidate runner source `57dfe4787e135a1ed97e735482e28e036297eeea` and its reviewed wrapper pin. QuickNode returned the same SDK and engine bytes and the exact gas-adjusted payout. The repeat used no model dispatch, Bot review, proof generation, or signed send. The service ledger has four settled drafts totaling $0.021312 and three Bot dispatches for the pilot wallet. This ledger does not measure Grok Bot billing.

Temporary buyer and solver SSH keys, solver Docker group membership, and the temporary SSH firewall rule were removed after verification.
