# Independent standards review report

2026-11-16 — Native Codex fallback. Review base: `43b4fca1a8d7db5b99b1607a0a5fce7ce61d4e83`, branch `codex/overnight-open-escrow`.

The requested Grok worker exited before producing files. This review ran in a native Codex subagent with the inherited session model. The runtime did not expose an exact model identifier to this worker. This report makes no Grok provenance claim.

## Result

- Use the pinned ABI. The core has documented differences from the current draft and its embedded reference.
- The existing zero-hook path permits a provider/evaluator adapter without another whitelist transaction.
- The proof guarantee belongs to the registered adapter policy or the selected-provider hook policy. Arbitrary zero-hook jobs have none.
- Keep x402 API fees separate from direct buyer bounty deposits. Reviewed sources do not establish direct x402 `core.fund` composition.

The [compatibility review](erc8183-compatibility.md) contains the analysis and exact source links. The [approved API](open-claim-v1.md) remains normative.

## Source snapshot

All hashes below use SHA-256. Existing repository files matched review base `43b4fca1a8d7db5b99b1607a0a5fce7ce61d4e83` when inspected.

| File | SHA-256 |
| --- | --- |
| `contracts/src/core/src/AgenticCommerce.sol` | `c90808d24aa18fc55ba3e170d524e8f321d9b329e307c0e6a125aa344829ec37` |
| `contracts/src/core/src/AgenticCommercePatched.sol` | `a16264d1a09f3e46843433d13e8360d574663935b8ca29f4339189b4fbd4d3bf` |
| `contracts/src/core/setBudget-client-only.patch` | `98887ae10e08040c0dc957ed6a07a753a651e3c23e402bc562f17099eb2bf618` |
| `contracts/src/SettlementHook.sol` | `1c84dcad987c7b6b2bdee4a7da54d3a70545046e0a0f4408e1cbc59a4d3c4fb0` |
| `contracts/abi/AgenticCommerce.json` | `3367687bfab04af1d54434b2f36bb4164b04e8ccab3f5f9737eae2f42ace86df` |
| `contracts/deployments/arc-testnet.json` | `53df2a1ae3850918078d8dded57ae6845296220e1a3eee84adb0a4ebba1ddacc` |
| `contracts/HANDOFF.md` | `97446328fd614685f7ab2b1795a5b6e813726d3837962219a93b35a3ed075da1` |
| `docs/overnight/open-claim-v1.md` | `981723a35778fe65397376205bb16109f67c614836058ba091213f6054a31d3f` |

The manifest also names historical settlement revision `027382fc00e116187bf4086a5d89408f580933fb`. That field is provenance metadata. The table above pins the source actually read.

During this review, the parent published more interface details at `198e4796c5063c8c838320c968654328fa8ec8f6`. The normative document then had SHA-256 `823534a192c279ef314b9a44e341f2b98cd8be9dcd9cf02d29be9420c95d3a23`. Its function signatures remained unchanged. The table retains the initial review snapshot.

External source pins, fetched on 2026-11-16:

| Source | Revision or capture | SHA-256 of fetched bytes |
| --- | --- | --- |
| [ERC-8183 source](https://github.com/ethereum/ERCs/blob/eb90f8e1b2ac75b20648d8bdb0a7affae985c44b/ERCS/erc-8183.md) | ERCs `eb90f8e1b2ac75b20648d8bdb0a7affae985c44b`, 2026-11-15T20:56:42Z | `257c35bbaecab58d0c36823fe8fb2d0fffc83d6f1fd7301d97674707784efa3a` |
| [EVM exact scheme](https://github.com/x402-foundation/x402/blob/1a084343e165d6f61b60b34f6146d6e4a4a7f3ca/specs/schemes/exact/scheme_exact_evm.md) | x402 `1a084343e165d6f61b60b34f6146d6e4a4a7f3ca`, 2026-11-13T16:34:31Z | `186111e25a5bdd5be839635ba1c441885567de09b57bdd93f78e465ca3b8e792` |
| [Circle supported endpoint](https://gateway-api-testnet.circle.com/v1/x402/supported) | HTTP 200, Date `Mon, 16 Nov 2026 06:27:07 GMT` | `6248b02171f490ad2b1b6ea2d2629972e681f6c52fcae0aaf4fb60b8cdff1189` |

The web reader could not access Circle's JSON endpoint. A direct read-only HTTPS GET succeeded. No request used a wallet or authentication token. The full response had 12 entries, `extensions: []`, and `signers: {"eip155:*": []}`. Its Arc entry follows:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:5042002",
  "extra": {
    "name": "GatewayWalletBatched",
    "version": "1",
    "verifyingContract": "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    "minValiditySeconds": 604800,
    "assets": [
      {"symbol":"USDC","address":"0x3600000000000000000000000000000000000000","decimals":6,"authorizationVersions":["1","2"]},
      {"symbol":"cirBTC","address":"0xf0c4a4ce82a5746abaad9425360ab04fbba432bf","decimals":8,"authorizationVersions":["2"]},
      {"symbol":"EURC","address":"0x89b50855aa3be2f677cd6303cec089b5f319d72a","decimals":6,"authorizationVersions":["2"]}
    ]
  }
}
```

This capability response proves advertisement at that time. It does not prove successful payment verification, settlement or arbitrary calldata support.

## Commands and results

Working directory for contract checks: `contracts/`. The tool path is exact:

```text
/Users/anishnarang/.local/share/ubc26/sprints/2026-11-15-core/tools/arc-foundry/forge
```

| Actual command | Exit | Result |
| --- | --- | --- |
| `<forge> --version` | 0 | `1.7.1-dev`, commit `3e95efaeaaaca64d6ac9c1ee988968683dbd0d22`. |
| `<forge> test --network arc --match-path 'test/core/Provenance.t.sol' --skip openclaim -vv` | 1 | Concurrent `OpenClaimRealReceipt.t.sol` imported adapter source that did not yet exist. Lowercase skip did not exclude that filename. |
| `<forge> test --network arc --match-path 'test/core/Provenance.t.sol' --skip OpenClaim -vv` | 0 | 7 passed, 0 failed, 0 skipped. |
| `<forge> test --network arc --match-path 'test/hook/HookEdgeCases.t.sol' --match-test 'test_hookless.*' --skip OpenClaim -vv` | 0 | 2 passed, 0 failed, 0 skipped. |
| `diff -u contracts/src/core/src/AgenticCommerce.sol contracts/src/core/src/AgenticCommercePatched.sol` from repository root | 1 | Expected diff exit. Exactly one changed line: provider-only becomes client-only `setBudget`. |
| `curl -fsS -D /tmp/ubc26-standards-circle.headers https://gateway-api-testnet.circle.com/v1/x402/supported -o /tmp/ubc26-standards-circle-supported.json` | 0 | HTTP 200. Parsed the response and retained its Arc entry above. |
| `curl -fsSL https://raw.githubusercontent.com/ethereum/ERCs/eb90f8e1b2ac75b20648d8bdb0a7affae985c44b/ERCS/erc-8183.md -o /tmp/ubc26-standards-erc8183.md` | 0 | Pinned draft read. |
| `curl -fsSL https://raw.githubusercontent.com/x402-foundation/x402/1a084343e165d6f61b60b34f6146d6e4a4a7f3ca/specs/schemes/exact/scheme_exact_evm.md -o /tmp/ubc26-standards-exact-pinned.md` | 0 | Pinned exact scheme read. Matched the contemporaneous main-branch fetch byte for byte. |
| Python source hashing and JSON parsing | 0 | Produced the hashes and capability projection above. |
| Python normalized reference comparison | 0 | Reported inequality. Inspection identified the initializer difference. This was a comparison result, not a test failure. |
| Pinned companion `cast sig '<canonical signature>'` through Python `subprocess.run` | 0 for each | Produced the selectors below. |
| Initial Python document validation | 1 | The parent changed the normative document during review. Its current bytes no longer equaled the initial base. The seven contract/handoff files still matched. |
| Final Python document validation | 0 | Checked 12 local links, eight historical hashes, seven unchanged source files, capability count, whitespace and final newlines. |
| `git diff --no-index --check /dev/null docs/overnight/erc8183-compatibility.md` | 1 | Expected no-index difference. No whitespace diagnostics. |
| `git diff --no-index --check /dev/null docs/overnight/standards-report.md` | 1 | Expected no-index difference. No whitespace diagnostics. |

The provenance suite checks the one-line patch, opposite pristine/patched budget callers, unchanged selectors, locked implementation, hook interface ID and non-whitelisted hook rejection. The zero-hook suite checks missing proof protection and a hook-evaluator job that can only recover through expiry. Neither suite tests the new adapter.

## Pinned core lifecycle selectors

| Signature | Selector |
| --- | --- |
| `createJob(address,address,uint256,string,address)` | `0x41528812` |
| `setProvider(uint256,address)` | `0xd0fae591` |
| `setBudget(uint256,uint256,bytes)` | `0xdd4ae9d4` |
| `fund(uint256,bytes)` | `0xe25ba707` |
| `submit(uint256,bytes32,bytes)` | `0x9e63798d` |
| `complete(uint256,bytes32,bytes)` | `0xd75bbdf3` |
| `reject(uint256,bytes32,bytes)` | `0x41dd26f5` |
| `claimRefund(uint256)` | `0x5b7baf64` |

`fund(uint256,uint256,bytes)` has selector `0xd2e13f50`. The pinned core does not implement it. An expected-budget draft client must not use it here.

## Adapter interface handoff

The approved function signatures produce these selectors. The parent owns the complete error/event inventory and source-to-ABI checks. This completed review covers the pinned core and x402 boundary.

| Signature | Selector |
| --- | --- |
| `register(uint256,bytes32,bytes32,bytes32,uint256,uint64)` | `0x22c1d372` |
| `claim(uint256,bytes,bytes,bytes32)` | `0xdbadcda7` |
| `release(uint256,bytes32)` | `0xdd20edf9` |
| `contextOf(uint256,address)` | `0xd19aca07` |
| `expectedJournal(uint256,address,bytes32,bytes32)` | `0x981fa9ee` |
| `core()` | `0xf2f4eb26` |
| `verifier()` | `0x2b7ac3f3` |
| `usdc()` | `0x3e413bee` |
| `terms(uint256)` | `0xc0aa0e8a` |
| `submissions(uint256)` | `0xad73349e` |
| `released(uint256)` | `0xa94d373b` |
| `MAX_ENVELOPE_BYTES()` | `0x93ec06be` |
| `MIN_EXPIRY_MARGIN()` | `0x958bcccb` |

## Scope and remaining checks

Changed paths: `docs/overnight/erc8183-compatibility.md` and `docs/overnight/standards-report.md` only. This worker did not stage, commit or push. It did not edit contracts, tests, ABIs, plans or status files. The parent owns repository status updates and shipping.

No wallet access, signing, live transactions, guest build or proof generation occurred. No new adapter deployment was verified. Parent review, adapter ABI parity, adversarial tests, receipt acceptance, payout accounting and final-source checks remain separate work. Before live use, repeat provenance and freeze verification at a fixed block under the deployment policy.
