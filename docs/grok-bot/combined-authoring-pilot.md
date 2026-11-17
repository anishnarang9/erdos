# Complete authoring cost pilot

Status — prepared for approval. On 2026-11-17, the user selected a 5–10¢ average target and requested a bounded pilot proposal. Paid execution of this proposal is pending.

## Scope

Run three complete attempts, one at a time, for the voyage-fee, cover-1 and mass-1 briefs. Use the original buyer briefs and declared outputs from the frozen corpus. The API model receives the complete existing schema and capability catalog. It must generate a fresh plan, requirement coverage, source quotes and examples.

Validate the generated plan and examples with the native engine. Give Grok Bot the exact brief, generated rules and native example verdicts through the existing webhook and restricted callback. Require a passed review and explicit buyer approval before native compilation. Run the independent oracle against the compiled checker. Generate one fresh proof for one accepted package and verify exact recovery. These checks consume no additional model calls.

Keep the input snapshots, native validation and review receipt bound to the generated revision. The old fixed plans and old Bot receipts cannot substitute for new authoring or review. Three attempts are a feasibility sample. The sprint's 180-trial qualification remains pending.

## Calls and limits

- Allow at most three direct API draft calls and three Bot review runs.
- Use the reviewed `grok-4.20-0309-non-reasoning` model, one completion and 2,048 completion tokens per API call.
- Run one complete attempt at a time. Confirm its final usage before starting another.
- Allow zero paid repair, clarification or automatic retry calls in this pilot. Set `AUTHORING_REPAIRS=0` in the pilot server. Record a clarification, truncated output or failed draft as an unsuccessful attempt.
- Retain the existing $1 Bot monthly additional-usage limit and disabled auto top-up. Inspect the remaining allowance before dispatch.
- Use a $0.50 incremental planning allowance across direct API and Bot usage. Stop before the next call if observed spend plus its estimate exceeds this allowance.
- Stop after any single attempt's observed combined cost exceeds $0.15, any uncertain dispatch or charge, missing usage evidence, changed provider terms, or invalid callback.
- Keep general public dispatch disabled throughout the pilot.

The $0.50 allowance is a stop rule for later dispatches. The provider may finish an active task after its account limit is crossed. The API tokenizer also omits provider-added framing. Approval must accept that an active attempt can exceed the planning allowance. A guaranteed per-run or aggregate dollar maximum is unavailable with the current provider controls.

## Cost estimate

The provider tokenizer was called on each exact serialized draft payload. Each payload includes the system instructions, buyer brief, full plan schema, capability catalog and structured response schema. The 512-token framing allowance below is a planning assumption.

| Brief | Payload bytes | Text tokens | API estimate at upper rates | Combined with prior Bot mean |
| --- | ---: | ---: | ---: | ---: |
| voyage-fee | 14,502 | 3,375 | 2.00¢ | 9.66¢ |
| cover-1 | 14,452 | 3,365 | 1.99¢ | 9.66¢ |
| mass-1 | 14,343 | 3,330 | 1.98¢ | 9.65¢ |

The API estimate prices text tokens plus 512 framing tokens at $2.50 per million and the full 2,048 output tokens at $5 per million. It uses no cache discount. The three prior Bot reviews moved the rounded account meters by $0.23 total, or about 7.67¢ each. These observations suggest $0.059736 for all three API drafts plus $0.23 for all three Bot reviews, or $0.289736 total. The 9.7¢ figure is the combined mean per attempt.

The cost target measures incremental provider inference charges for authoring and review. Native checks use the existing VPS allocation, and the proof uses the existing local prover. Record their runtimes separately. Allocated monthly hosting cost and local electricity remain outside this inference figure. Any newly required paid compute must return for approval before provisioning.

Fresh generated rules can change Bot effort. The sample does not establish a stable average, and five cents remains an unmet target. The previous strict guard reserves $2.54096 for an API request. The proposed pilot needs a separate, explicit admission mode for estimated spending. The production guard stays strict until that mode has been implemented and verified.

## Measurement and verdict

Record the direct API's actual uncached, cached and completion usage using the applicable tariff. Capture Bot account usage immediately before and after every task, preserving its rounded precision and any unrelated activity. Count every failed attempt in spend and success-rate calculations.

Report the combined total, mean per attempted run, mean per accepted compiled plan, highest observed attempt, failures and cost uncertainty. Passing requires three newly authored, Bot-reviewed compiled plans with correct oracle outcomes and a combined mean at or below 10¢. A result between 5¢ and 10¢ satisfies the revised pilot cost target. Fewer accepted plans or a higher mean fails this pilot.

If task billing cannot be attributed, report the meter delta and leave the cost verdict unresolved. Preserve the Bot conversation export where available. The current shared Bot account permits only these synthetic public-corpus inputs. Public customer dispatch still requires an account with the intended review tools and no unrelated private sessions.

## Approval requested

Approve these three attempts under the $0.50 incremental planning allowance, including possible in-flight overrun, and the stated stop rules. This proposal includes no credit purchase or chain transaction.

[Tokenizer reference](https://docs.x.ai/developers/rest-api-reference/inference/other) · [Billing framing caveat](https://docs.x.ai/developers/faq/billing) · [API pricing](https://docs.x.ai/developers/pricing) · [Bot billing controls](https://docs.x.ai/grok-bot/faq)
