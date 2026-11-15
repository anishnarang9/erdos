# Marketplace integration options

> **Update (Neil, 2026-11-14 15:45 -05:00).** Main uses an **isolated** ERC-8183 core with our own hook and evaluator, not Circle's shared ACP. As a result:
> - Option #1 becomes a reference and comparison point, not the escrow we settle on.
> - Issue #4 (Circle can upgrade the ACP) no longer applies.
> - Issue #3 still applies, because adopting us still requires the SDK helper.
>
> Issues #1, #2, #5 and #6, and options #1b (x402 and the Circle Agent Marketplace) and #4 (ERC-8004), carry into [COMMERCE-IMPLEMENTATION.md §7](COMMERCE-IMPLEMENTATION.md#7-marketplace-and-sponsor-integration).

Status: **proposed** by Neil, 2026-11-14. These are candidates for demonstrating that the proof-gated evaluator works with an existing agent marketplace. Only the first entry was checked on-chain; the rest come from web search and their READMEs. Check the code before depending on any of them.

## Ranked shortlist

| # | Option | Chain | Why it fits | Integration effort | Risk |
| --- | --- | --- | --- | --- | --- |
| 1 | **Circle ERC-8183 `AgenticCommerce` on Arc** `0x0747EEf0706327138c69792bF28Cd525089e4583` | Arc testnet | This is the shared kernel that Arc's ERC-8183 ecosystem uses. It has about 193k jobs, 0 fees, and allows `hook = 0`. Our evaluator plugs in with no changes on either side. **This is the core integration.** | Already in the design | Low. The proxy could be upgraded by Circle, so pin the implementation address and check it before the demo. |
| 1b | **Circle Agent Marketplace** (launched Jul 2026; keyless Discovery API in the x402 Bazaar schema) plus **Circle's x402 facilitator** (launched Sep 2026 on Arc, Base and Polygon) | Arc | This is Circle's own catalog of agent services. If we put our verify or compile endpoint behind x402 and apply for a listing, "plugs into an existing marketplace" is literally true on the sponsor's own platform. It also covers the track's "services agents can discover and pay for in USDC". | Medium (½ day in G3) | Check on Nov 15 that the facilitator covers Arc **testnet**. Claim only "listing submitted". |
| 2 | **`vijaygopalbalasa/ARC`**: open job market (ArcBounty, BaseBounty, NadBounty) with ERC-8183 escrow, ERC-8004 identity, "encrypted contests" | Arc, Base, Monad | **Integration is not possible**, per the settlement review. Its `BountyAdapter.sol` takes all three ACP roles itself (`createJob(address(this), address(this), …)`, line 448), so a custom evaluator cannot be used. It does use Circle's `0x0747…4583`, which supports our "shared kernel" claim. Its "encrypted contests" feature makes it **competitive context** only. | n/a | 0 stars, last push 2026-10-26 |
| 3 | **`xseven0908/arc-agent-work-market`**: "proof-backed AI agent work marketplace on Arc", ERC-8004 + ERC-8183, viem | Arc | Same stack as ours. We could fork its UI and job board and swap in our evaluator. | Low–medium | Stale (last push 2026-09-17, 0 stars). |
| 4 | **ERC-8004 IdentityRegistry on Arc** `0x8004A818BFB912233c491871b3d84c89A494BD9e` (bytecode confirmed) | Arc | Register the worker agent's identity. Optionally post a reputation entry after each accepted proof ("proof-verified delivery"). Cheap and adds to the agentic-economy story. | Low | Unverified ABI version; read the verified source first. |
| 5 | **Virtuals ACP v2**, the reference ERC-8183 implementation from Virtuals | Base | This is the largest ERC-8183 agent marketplace. The pitch can say our evaluator is ERC-8183-native, so it is portable to ACP v2 jobs. | High for this week (different chain, SDK) | Use as the follow-on/pitch slide, not the live demo. |
| 6 | **BNBAgent SDK**, an ERC-8183 client stack in Python whose evaluator uses UMA's optimistic oracle | BNB | Good for contrast: optimistic, disputable evaluation versus our cryptographic evaluation. | Pitch only | none |
| 7 | **x402 Bazaar / Agentic.Market** (Coinbase directory of x402 services) | Base (Circle facilitator advertises Arc `exact`) | List our `/compile` or `/draft` API as a paid x402 service. This covers the "authoring and verification service plugs into a marketplace" requirement. | Medium (stretch, after the core flow is stable) | Bazaar indexing works through the CDP facilitator, so Arc listing is unconfirmed. |
| 8 | **BasedAgents** (Apache-2.0 task marketplace, USDC escrow on Base over x402, MCP server) | Base | It is open source and has an API and MCP server, so our worker could take tasks from it. | High (chain mismatch) | Small (8 bounties paid). |

## Current integration issues (Neil, 2026-11-14)

Ranked by risk. Each has an owner lane and a deadline.

| # | Issue | Impact | Fix | Owner and deadline |
| --- | --- | --- | --- | --- |
| 1 | **Circle's ACP is an escrow kernel, not a marketplace.** Agents don't browse it, so no worker discovers our jobs unless we tell them. | "Plugs into a marketplace" is only half true. | Our API exposes a job feed that workers poll. Pair it with the Circle Agent Marketplace listing (#2). Pitch it accurately: "runs on Circle's shared ERC-8183 escrow". | L3, G3 (Nov 17) |
| 2 | **Circle's x402 facilitator and Agent Marketplace are unconfirmed for us.** Arc *testnet* support is unknown, a listing needs Circle's approval on their timeline, and x402 is pay-first, so it fits only a paid API call (`/compile`), not the bounty. | The sponsor-tool story could fall through. | Check testnet support on Nov 15. Ask at Circle office hours on Nov 16. Claim only "listing submitted". The bounty stays on ACP escrow. | L2, Nov 15–16 |
| 3 | **Existing marketplaces need code changes to adopt us.** The buyer must call `registerTerms` before funding, and the evaluator is fixed at `createJob`, so it cannot be added later. ArcBounty takes all three roles itself. Virtuals ACP v2 is on Base with its own SDK, which would take days to port. | No third-party marketplace UI can drive our evaluator this week. | For the demo, our app is the marketplace front-end on Circle's ACP. For the pitch, show a small SDK (`createJob` + `registerTerms` + `fund` in one helper) so any ERC-8183 marketplace can adopt it. Virtuals and Base go in the roadmap. | L3 (SDK helper), pitch |
| 4 | **Circle controls the contract.** The ACP is UUPS-upgradeable by Circle at any time, and custom hooks need Circle's admin whitelist, which is why we use the evaluator route. | An upgrade before Nov 21 could break the flow. | The app and worker check the ERC-1967 implementation slot (`0xa316fd02…`) before signing. Ask Circle on Nov 16 whether an upgrade is planned. Keep a self-deployed copy of the verified source as a hot standby. | L2, Nov 16 |
| 5 | **The shared contract is noisy and the RPC is limited.** It has about 193k jobs. The public RPC rate-limits after a few calls per second and caps `getLogs` at 10k blocks (about 2 hours). | The worker or UI can miss jobs and results. | The API indexes only our jobs (by evaluator = PG), the worker keeps a persisted block cursor with backoff, and we use a second or paid RPC. Use QuickNode Streams if it is live on Arc testnet. | L3, G3 |
| 6 | **Test money is limited.** The faucet caps how much test USDC we get, and gas is paid in the same USDC. | Demo wallets could run dry. | Bounties of 1–5 USDC. Fund the deployer, buyer and worker wallets on Nov 15. Tests subtract gas from balance checks. | L2, Nov 15 |

**Bottom line:** the core integration with Circle's ERC-8183 on Arc works today (checked on-chain, read-only). The risks are discovery (#1, #3) and unconfirmed sponsor tooling (#2, #4). All of them should be settled by the Nov 16 office hours.

## Recommendation

- **Live demo:** use #1, Circle ACP on Arc, as the escrow kernel. Add #1b: an x402-paid `/compile` endpoint through Circle's facilitator and an Agent Marketplace listing application. Add #4: the worker registered in ERC-8004, with its agentId in the manifest. Together these cover the sponsor's "Wallets, x402, Agent Marketplace" checklist.
- **Circle office hours** (Nov 16 and Nov 18, 18:00–19:00 CST). Ask whether the ACP will be upgraded before Nov 21, whether the facilitator covers Arc testnet, and how listings work.
- **Competitor to name:** Horizen Labs' agent registry (ZK plus x402, but with an LLM judge and agents still "In Development").
- **Evidence for the pitch (to be measured, S task):** sample the last ~500 ACP jobs with `getJob` (this avoids the `getLogs` cap). Count EOA vs. contract evaluators and how often evaluator == client. If most are EOAs, meaning someone simply clicks "complete", that one chart shows the trust gap our proof closes. Do not claim it before it is measured, and caveat that the 193k jobs include test traffic.
- ~~ArcBounty cross-post~~: dropped, because its adapter takes all three roles itself.
- **Pitch slide:** show #5, #6 and #7 as places the same evaluator ports to, since all of them speak ERC-8183 or x402.

## Sources

- [EIP-8183](https://eips.ethereum.org/EIPS/eip-8183)
- [Arc blog: agentic economic flow with ERC-8183](https://www.arc.io/blog/running-an-agentic-economic-flow-on-arc-with-erc-8183)
- [circlefin/arc-node ERC-8183 guide PR #219](https://github.com/circlefin/arc-node/pull/219), [PR #123](https://github.com/circlefin/arc-node/pull/123)
- [vijaygopalbalasa/ARC](https://github.com/vijaygopalbalasa/ARC), [xseven0908/arc-agent-work-market](https://github.com/xseven0908/arc-agent-work-market)
- [Virtuals ACP overview](https://os.virtuals.io/acp/overview), [ACP changelog](https://whitepaper.virtuals.io/acp/acp-changelogs)
- [BNBAgent SDK](https://www.bnbchain.org/en/blog/bnbagent-sdk-the-first-live-erc-8183-implementation-for-onchain-ai-agents)
- [x402 Bazaar](https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar), [Agentic.Market](https://www.coinbase.com/developer-platform/discover/launches/agentic-market)
- [BasedAgents](https://github.com/maxfain/basedagents)
