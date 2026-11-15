# @ubc26/sdk contract (T2 codec, T3 chain adapter)

**Status:** proposed, 2026-11-14. The implementation and the tests both follow this file. If code and this file disagree, this file is right until it is changed on purpose.

**Sources:**
- Byte formats: [ZKVM-IMPLEMENTATION.md §2–3](../../agents/current%20plan/ZKVM-IMPLEMENTATION.md) (Anish). The engine is authoritative.
- Lifecycle: [WORK-SPLIT.md §2](../../agents/current%20plan/WORK-SPLIT.md) (Nick).

Everything under "Chain" is **SIMULATED**. Nick's real ABI is not published yet, so the stub contracts here follow the ERC-8183 draft shape and the lifecycle in the work split. When his ABI lands, only `src/chain/abi.ts` and `contracts/` should change.

## Exports

| Import path | What it contains |
| --- | --- |
| `@ubc26/sdk` | Codec and chain |
| `@ubc26/sdk/testing` | Helpers for tests and SIMULATED fixtures only. Never used in production paths. |

## 1. Codec (`src/codec/`)

### Types

```ts
import type { Address, Hex } from "viem";

interface FundedContext {
  chainId: bigint; escrow: Address; jobId: bigint; provider: Address;
  rulesHash: Hex; referenceHash: Hex;            // 32 bytes each
}
interface BundleFile { name: string; content: Uint8Array }
interface Journal { context: FundedContext; verdict: 0 | 1; envelopeHash: Hex; keyCommitment: Hex }
interface ProofPackage {
  version: 1; context: FundedContext; contextBytes: Uint8Array; imageId: Hex; verdict: 0 | 1;
  envelope: Uint8Array; envelopeHash: Hex; keyCommitment: Hex; journal: Uint8Array; journalDigest: Hex; seal: Hex;
}
class CodecError extends Error { readonly code: CodecErrorCode }
type CodecErrorCode =
  | "bad_length" | "bad_version" | "bad_hex" | "bad_field" | "bad_name" | "duplicate_name"
  | "unsorted" | "too_many_files" | "trailing_bytes" | "auth_failed" | "mismatch" | "bad_selector";
```

### Constants

```ts
CONTEXT_LENGTH = 169; JOURNAL_LENGTH = 234; KEY_LENGTH = 32; NONCE_LENGTH = 12; TAG_LENGTH = 16;
MAX_BUNDLE_FILES = 16; MAX_DELIVERY_BYTES = 16384; SEAL_SELECTOR = "0xe71e6620";
TAG_KEY = "UBC26/key/v1"; TAG_REFERENCE = "UBC26/reference/v1";
```

All hashes are SHA-256. Hash outputs are lowercase `0x` hex.

### Functions

| Function | Behaviour | Errors |
| --- | --- | --- |
| `encodeContext(ctx: FundedContext): Uint8Array` | `0x01` ‖ chainId (u256 big-endian) ‖ escrow (20 bytes) ‖ jobId (u256 BE) ‖ provider (20) ‖ rulesHash (32) ‖ referenceHash (32). Output is 169 bytes. | `bad_field`: chainId or jobId is negative or ≥ 2²⁵⁶, an address is invalid, or a hash is not 32 bytes |
| `decodeContext(bytes: Uint8Array): FundedContext` | Inverse of `encodeContext`. Addresses are returned EIP-55 checksummed (viem `getAddress`). Hashes are returned as lowercase hex. | `bad_length` if the input is not 169 bytes. `bad_version` if the first byte is not `0x01`. |
| `encodeBundle(files: BundleFile[]): Uint8Array` | `0x01` ‖ u16be(count), then for each file: u16be(nameLen) ‖ name ‖ u32be(len) ‖ content. Files are sorted by ascending name **bytes**, and the input order does not matter. An empty list encodes to `010000`. | `bad_name`: the name does not match `^[A-Za-z0-9._-]{1,128}$`, or is `.` or `..`. `duplicate_name`. `too_many_files` above 16. |
| `decodeBundle(bytes: Uint8Array): BundleFile[]` | Strict inverse. | `bad_version`. `bad_length` if truncated. `bad_name`. `duplicate_name` for equal adjacent names. `unsorted` for descending names. `too_many_files` if count > 16. `trailing_bytes`. |
| `envelopeHash(envelope: Uint8Array): Hex` | `SHA256(envelope)` | none |
| `keyCommitment(context: Uint8Array \| FundedContext, key: Uint8Array): Hex` | `SHA256(ASCII("UBC26/key/v1") ‖ context[169] ‖ key[32])` | `bad_length` if the context is not 169 bytes or the key is not 32 bytes |
| `referenceHash(referenceBundle: Uint8Array): Hex` | `SHA256(ASCII("UBC26/reference/v1") ‖ bundle)` | none |
| `encodeJournal(j: Journal): Uint8Array` | context[169] ‖ verdict[1] ‖ envelopeHash[32] ‖ keyCommitment[32]. Output is 234 bytes. | `bad_field` |
| `decodeJournal(bytes: Uint8Array): Journal` | Inverse | `bad_length` if not 234 bytes. `bad_version`. `bad_field` if the verdict is not 0 or 1. |
| `journalDigest(journal: Uint8Array): Hex` | `SHA256(journal)` | `bad_length` if not 234 bytes |
| `decryptEnvelope(envelope, key, context): Uint8Array` | The envelope is nonce[12] ‖ ciphertext ‖ tag[16]. Decrypts with ChaCha20-Poly1305 (RFC 8439), using the 169 context bytes as AAD. | `bad_length` if the envelope is shorter than 28 bytes, the key is not 32 bytes, or the context is not 169 bytes. `auth_failed` if the tag check fails. |
| `parseProofJson(json: unknown): ProofPackage` | See the rules below. | See the rules below. |

`parseProofJson` accepts an object or a JSON string and applies these rules:
- The required fields are `version`, `context`, `imageId`, `verdict`, `envelope`, `keyCommitment`, `journal` and `seal`. A missing or mistyped field gives `bad_field`.
- Byte fields are `0x` hex strings. Upper and lower case are both accepted. Invalid hex gives `bad_hex`.
- `version` and `verdict` can be a number or a decimal string. The JSON type is UNSPECIFIED by the engine, so both are accepted. `version` must equal 1 and `verdict` must be 0 or 1, otherwise `bad_field`.
- `context` must be 169 bytes. `imageId` and `keyCommitment` must be 32 bytes.
- The `journal` must equal `encodeJournal({decoded context, verdict, SHA256(envelope), keyCommitment})` byte for byte, otherwise `mismatch`.
- The `seal` must start with `0xe71e6620`, otherwise `bad_selector`.

### Testing helpers (`@ubc26/sdk/testing`)

- `encryptEnvelope(plaintext, key, nonce, context): Uint8Array` returns nonce ‖ ciphertext ‖ tag. It exists only for tests and fixtures, because the real envelope is produced inside the guest.
- `simulatedSeal(imageId: Hex, journalDigest: Hex): Hex` returns `0xe71e6620 ‖ SHA256(imageId[32] ‖ journalDigest[32])`. This is the format accepted by `MockRiscZeroVerifier`. It is SIMULATED.
- `ENGINE_FIXTURE` is the synthetic fixture from ZKVM-IMPLEMENTATION §3, with every input and expected value as hex.

### Required vectors

These come from the engine plan and were recomputed with Node `crypto`.

| Input | Value |
| --- | --- |
| chainId | 5042002 |
| jobId | 7 |
| escrow | `11`×20 |
| provider | `22`×20 |
| rulesHash | `33`×32 |
| referenceHash | `44`×32 |
| verdict | 1 |
| key | `55`×32 |
| nonce | `66`×12 |
| plaintext | bundle containing `a.txt` = `ok` |

```text
context       = 01 + 00*29 4cef52 + 11*20 + 00*31 07 + 22*20 + 33*32 + 44*32
bundle        = 0100010005612e747874000000026f6b
envelope      = 666666666666666666666666f4846535e153e02fbd1c8c3a8fff73b6b3ad081d0b4838c0baa5dea92b84d556
envelopeHash  = ad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6
keyCommitment = 3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d
journalDigest = 9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e
```

### Settled during cross-validation (2026-11-14)

- In `parseProofJson`, a wrong-length `context`, `imageId` or `keyCommitment` gives `bad_length`. Invalid JSON text or a non-object input gives `bad_field`. Checks run in this order: presence and type, hex, version and verdict, sizes, journal (`mismatch`), selector. The function does not limit the envelope size; the delivery cap is checked on-chain.
- `decryptEnvelope` and `keyCommitment` take the context as bytes. `keyCommitment` also accepts a `FundedContext`.
- `ENGINE_FIXTURE` is a flat object of hex values, with `chainId` and `jobId` as bigints, plus `fundedContext` and `files`.

## 2. Chain (`src/chain/`), SIMULATED

### Stub contracts (`contracts/*.sol`, Solidity 0.8.38)

Compile them with `pnpm build:contracts` (solc-js). The artifacts go to `contracts/out/artifacts.json` and are committed. Every contract carries a `// SIMULATED: stand-in until Nick's settlement contracts land` header.

**`MockUSDC`** is an ERC-20 with 6 decimals and a public `mint(address,uint256)`.

**`StubCore`** has the ERC-8183 draft shape. Its constructor is `constructor(address token)`. Status values are `Open=0, Funded=1, Submitted=2, Completed=3, Rejected=4, Expired=5`.

Hook interface: `beforeAction(uint256 jobId, bytes4 selector, bytes data)` and `afterAction(...)`.
- For `fund`, the hook gets `data = optParams`.
- For `submit`, the hook gets `data = abi.encode(bytes32 deliverable, bytes optParams)`.
- Hooks are called only when `hook != address(0)`.

| Function | Rules |
| --- | --- |
| `createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256 jobId)` | `expiredAt > block.timestamp`, otherwise `InvalidExpiry()`. Job IDs start at 1. Emits `JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, address hook, uint256 expiredAt)`. |
| `setBudget(uint256 jobId, uint256 amount, bytes optParams)` | Client or provider only. Open only. Emits `BudgetSet(uint256 indexed jobId, uint256 amount)`. |
| `fund(uint256 jobId, uint256 expectedBudget, bytes optParams)` | Client only. Open only. `budget > 0`, otherwise `ZeroBudget()`. `budget == expectedBudget`, otherwise `BudgetMismatch()`. Order: before hook, then `transferFrom(client → core)`, then status Funded, then after hook. Emits `JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)`. |
| `submit(uint256 jobId, bytes32 deliverable, bytes optParams)` | Provider only. Funded only. `block.timestamp < expiredAt`, otherwise `JobExpired()`. Order: before hook, then status Submitted, then after hook. Emits `JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)`. |
| `complete(uint256 jobId, bytes32 reason, bytes optParams)` | Evaluator only. Submitted only. Pays the budget to the provider and sets status Completed. Emits `JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)` and `PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)`. |
| `claimRefund(uint256 jobId)` | Anyone. Funded or Submitted only. `block.timestamp >= expiredAt`, otherwise `NotExpired()`. Refunds the client and sets status Expired. Calls no hook. Emits `Refunded(uint256 indexed jobId, address indexed client, uint256 amount)`. |
| `getJob(uint256 jobId) view returns (Job)` | `Job { address client; address provider; address evaluator; address hook; uint256 budget; uint256 expiredAt; uint8 status; string description; }` |

Errors: `Unauthorized()`, `WrongStatus(uint8 status)`, `InvalidExpiry()`, `ZeroBudget()`, `BudgetMismatch()`, `JobExpired()`, `NotExpired()`.

**`StubProofGate`** is one contract that acts as both hook and evaluator. Its constructor is `constructor(address core, address verifier)`. The hook functions are callable only by the core.

- **Fund, before hook:** decode `(bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash)`. All three must be non-zero, otherwise `InvalidTerms()`.
- **Fund, after hook:** read the job from the core and freeze `{imageId, rulesHash, referenceHash, provider, budget, expiredAt}`. Emit `TermsFrozen(uint256 indexed jobId, bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash)`.
- **Submit, before hook:**
  1. Decode `(bytes32 deliverable, bytes optParams)`, then decode `optParams` as `(bytes envelope, bytes seal, bytes32 keyCommitment)`.
  2. `envelope.length <= 16384`, otherwise `EnvelopeTooLarge()`.
  3. `sha256(envelope) == deliverable`, otherwise `EnvelopeHashMismatch()`.
  4. Build `context = abi.encodePacked(uint8(1), block.chainid, address(core), jobId, provider, rulesHash, referenceHash)` (169 bytes).
  5. Build `journal = abi.encodePacked(context, uint8(1), deliverable, keyCommitment)`.
  6. Call `verifier.verify(seal, imageId, sha256(journal))`. If it reverts, the submit reverts.
  7. Store `{envelopeHash, keyCommitment}`. Emit `SubmissionAccepted(uint256 indexed jobId, bytes32 envelopeHash, bytes32 keyCommitment)`.
- **`release(uint256 jobId, bytes32 key)`:**
  1. The caller must be the frozen provider, otherwise `Unauthorized()`.
  2. The core status must be Submitted, otherwise `WrongStatus(uint8)`.
  3. `block.timestamp < expiredAt`, otherwise `JobExpired()`.
  4. `sha256("UBC26/key/v1" ‖ context ‖ key) == keyCommitment`, otherwise `KeyMismatch()`.
  5. Not already released, otherwise `AlreadyReleased()`.
  6. Call `core.complete(jobId, bytes32(0), "")`. Emit `KeyReleased(uint256 indexed jobId, bytes32 key)`.
- **Note:** `AlreadyReleased()` cannot be reached in practice. The first release moves the job to Completed, so a second release reverts at step 2 with `WrongStatus`. The guard stays as defence in depth.
- **Fund event order:** USDC `Transfer`, then `TermsFrozen`, then `JobFunded`. Consumers must not assume `JobFunded` comes first.
- **Views:**
  - `getTerms(uint256) returns (bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash, address provider, uint256 budget, uint256 expiredAt)`, with zeros if the job was never funded.
  - `getAcceptance(uint256) returns (bytes32 envelopeHash, bytes32 keyCommitment)`, with zeros if nothing was accepted.

**`MockRiscZeroVerifier`** implements `verify(bytes seal, bytes32 imageId, bytes32 journalDigest) view`. It reverts with `VerificationFailed()` unless `seal == abi.encodePacked(bytes4(0xe71e6620), sha256(abi.encodePacked(imageId, journalDigest)))`.

### TypeScript adapter

```ts
enum JobStatus { Open = 0, Funded = 1, Submitted = 2, Completed = 3, Rejected = 4, Expired = 5 }
interface ChainConfig { chainId: number; core: Address; hook: Address; usdc: Address }
interface JobView { client: Address; provider: Address; evaluator: Address; hook: Address; budget: bigint; expiredAt: bigint; status: JobStatus; description: string }
interface FrozenTerms { imageId: Hex; rulesHash: Hex; referenceHash: Hex; provider: Address; budget: bigint; expiredAt: bigint }
type PreflightResult = { ok: true } | { ok: false; error: string };  // error = decoded custom error name, or "unknown"
interface DecodedEvent { name: string; contract: "core" | "hook" | "usdc"; args: Record<string, unknown>; blockNumber: bigint; logIndex: number; transactionHash: Hex }

function createCommerceChain(cfg: ChainConfig, clients: { public: PublicClient; wallet?: WalletClient }): CommerceChain;
```

The `CommerceChain` methods are below. Every write waits for its receipt and **throws `ChainError` when the receipt status is `reverted`**, unless `opts.allowRevert` is true, in which case it returns the hash.

| Method | Signer | Notes |
| --- | --- | --- |
| `approveUsdc(amount)` | buyer | `approve(core, amount)` |
| `createJob({provider, expiredAt, description})` → `{hash, jobId}` | buyer | Sets evaluator and hook to `cfg.hook`. Reads `jobId` from `JobCreated`. |
| `setBudget(jobId, amount)` | buyer or provider | |
| `fund({jobId, expectedBudget, imageId, rulesHash, referenceHash})` | buyer | `optParams = abi.encode(bytes32, bytes32, bytes32)` |
| `preflightSubmit({jobId, envelope, seal, keyCommitment})` → `PreflightResult` | provider | `eth_call` that sends nothing |
| `submit({jobId, envelope, seal, keyCommitment}, opts?: {gas?: bigint; allowRevert?: boolean})` | provider | Computes `deliverable = envelopeHash(envelope)` itself. If `gas` is given, gas estimation is skipped, so a reverting submit can still be mined for the "rejected" demo. |
| `preflightReleaseWithDummyKey(jobId)` → `PreflightResult` | provider | Runs `eth_call` on `release` with a key of all zero bytes. Returns `{ok:true}` **only when** the revert is `KeyMismatch`, which shows the release path is reachable. The real key is never sent in an `eth_call`. |
| `release(jobId, key: Hex, opts?)` | provider | |
| `claimRefund(jobId, opts?)` | anyone | |
| `getJob(jobId)` → `JobView`, `getTerms(jobId)` → `FrozenTerms \| null`, `getAcceptance(jobId)` → `{envelopeHash, keyCommitment} \| null` | read | |
| `decodeLogs(logs)` → `DecodedEvent[]` | read | Decodes core, hook and USDC `Transfer` events and skips unknown logs |
| `getSubmittedEnvelope(txHash)` → `{jobId, envelopeHash, envelope, seal, keyCommitment}` | read | Decodes the `submit` calldata. Throws if the transaction is not a `submit` to `cfg.core`. |

Also exported:
- `class LogCursor`
  - Constructor: `new LogCursor(publicClient, { addresses, fromBlock, decode: (logs) => DecodedEvent[], maxRange = 10_000n, store: { load(): bigint | null; save(block: bigint): void }, confirmations = 0n })`. Pass `chain.decodeLogs` as `decode`.
  - `next(): Promise<DecodedEvent[]>` reads from `store.load() + 1` (or from `fromBlock`) up to `min(head - confirmations, from + maxRange - 1)`. It returns `[]` when there is nothing in the window. `cursor.caughtUp` is `true` once the cursor has reached `head - confirmations`. It saves the cursor only after the read succeeds.
  - All RPC calls go through `withRetry`.
- `withRetry(fn, { retries = 5, baseMs = 250 })` retries on rate-limit errors (JSON-RPC code `-32005`, HTTP 429, or a message containing "rate limit") with exponential backoff. Any other error is rethrown immediately.
- `ChainError extends Error { code: "reverted" | "wrong_chain" | "not_submit" | "no_wallet"; errorName?: string }`.

### Test harness (`test/support/`)

- `startAnvil(): Promise<{ rpcUrl: string; stop(): Promise<void> }>` uses the `@foundry-rs/anvil` binary on a free port, with chain ID 31337 and the default mnemonic.
- `deployStub(rpcUrl)` returns `{ core, hook, usdc, verifier, buyer, provider, other, publicClient, walletFor(account) }`. It mints 1,000 USDC (`1_000_000_000` base units) to the buyer.
- `increaseTime(rpcUrl, seconds)` calls `evm_increaseTime` and then `evm_mine`.
- If the anvil binary cannot start, chain tests call `it.skip` with an explicit reason that is printed. They never pass silently.
