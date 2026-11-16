# x402 paid compile route, version 1

This route charges for the API compile service. It does not fund the ERC-8183 bounty. The existing `POST /v1/jobs/:id/compile` route remains available and keeps its current contract. The paid route calls the same approval gate and compile handler.

## `POST /v1/jobs/:id/paid-compile`

Use the buyer bearer token. Send JSON `{ "revisionHash": "0x..." }` for the approved current revision. The server checks the job and approval before it offers a payment. A compiled job returns its stored result without a new charge.

When no payment is present, the server returns HTTP 402. `PAYMENT-REQUIRED` is base64 encoded x402 v2 JSON. It contains one `exact` requirement, the configured network, token, amount in token base units, payee, and the resource URL. The requirement uses `extra.paymentFlow = "upfront"`: the facilitator settles the API fee before compilation.

The buyer signs a payment for the exact requirement and repeats the same request with `PAYMENT-SIGNATURE`, a base64 encoded x402 v2 payment payload. The server checks that its `resource` and `accepted` fields match the quote. It sends the payload and requirement to the configured facilitator's `/settle` endpoint. A confirmed settlement returns an HTTP response with `PAYMENT-RESPONSE`, a base64 encoded settlement receipt. The compile result has the same JSON shape as `POST /v1/jobs/:id/compile`.

The server records the payment before it calls the facilitator. If the call times out, the connection fails, or the outcome is unclear, it returns `payment_pending` (409). It never sends that payment again without reconciliation. If compilation fails after settlement, the response still carries `PAYMENT-RESPONSE`. A repeat with the same signed payload and request retries compilation without another settlement. A successful result is stored and replayed with `Idempotent-Replayed: true`. Reusing one payment for a different job or revision returns `payment_conflict` (409).

SQLite migrations `007_x402_payments.sql` and `009_x402_quote_snapshot.sql` hold this state and the exact quote across API restarts. An already settled payment can retry even if the current service quote changes. Operators must inspect the facilitator or chain receipt before resolving a `payment_pending` row. There is no automatic refund for an API fee when the compile engine fails. A buyer can retry the paid compile with the same payload after a confirmed settlement.

## Server configuration

Set these values only for a server that should offer the paid route:

| Variable | Meaning |
| --- | --- |
| `X402_FACILITATOR_URL` | Base URL of an x402 v2 facilitator. The server calls `/settle` once for a new payment. |
| `X402_FACILITATOR_TOKEN` | Optional bearer token for the facilitator. Keep it in the process environment or ignored `.env`. |
| `X402_RESOURCE_BASE_URL` | Public API origin used in the signed resource URL. |
| `X402_NETWORK` | CAIP-2 network. Defaults to `eip155:5042002` for Arc Testnet. |
| `X402_ASSET` | Token address. Defaults to Arc native USDC `0x3600000000000000000000000000000000000000`. |
| `X402_PAY_TO` | Address that receives the API service fee. |
| `X402_AMOUNT` | Positive decimal amount in token base units. |
| `X402_EXTRA_JSON` | Exact facilitator-specific `extra` object from its supported scheme. The server adds `paymentFlow: "upfront"`. |

Use the facilitator's current `/supported` response to choose the network, asset, and `extra` fields. A Circle Gateway quote can require a Gateway wallet method and deposit semantics. Do not treat that API fee as a direct transfer into the bounty core. The local tests use a test facilitator and an EIP-3009 signature; they do not establish a live Circle payment.

## Local check

From `commerce/api`, run `pnpm exec vitest run test/unit/x402-paid-compile.test.ts`. The test makes a 402 request, signs a local test authorization, settles it with a test facilitator, and checks one charge across a retry and process restart. It also checks that an unapproved job cannot reach settlement. No external facilitator, API key, or live wallet is used.
