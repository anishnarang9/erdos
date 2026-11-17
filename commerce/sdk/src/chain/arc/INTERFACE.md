# `@ubc26/sdk` Arc settlement interface

Implemented against Nick's settlement source `80c8a4af68f0cf00e4177c98e9c435d869716edd` and viem 2.57.19. The copied ABIs are under `abi/`. `nick-examples/` contains reference code, with a corrected Node `setAAD` call in its fixture test.

## Implemented public exports

Import these directly from `@ubc26/sdk`; there is no `arc` namespace:

- `createArcReader(config: ChainConfig, publicClient: PublicClient): ArcReader`
- `arcCoreAbi`, `arcHookAbi`, `arcErc20Abi`
- Types `ArcReader`, `ArcSnapshot`, and the existing `ChainConfig`, `JobView`, `FrozenTerms`, `DecodedEvent`.

`ArcReader` exposes:

- `getSnapshot(jobId: bigint, blockNumber?: bigint): Promise<ArcSnapshot>`
- `getJob(jobId: bigint, blockNumber?: bigint): Promise<JobView>`
- `getTerms(jobId: bigint, blockNumber?: bigint): Promise<FrozenTerms | null>`
- `decodeLogs(logs: readonly Log[]): DecodedEvent[]`

A snapshot contains `blockNumber`, `timestamp`, `job`, `terms`, `context: Uint8Array`, `submission: { envelopeHash, keyCommitment, accepted }`, and `released`. It selects one uncached block and pins all contract reads and the timestamp to that block. It verifies the RPC chain and on-chain job ID. Job status uses the SDK's numeric `JobStatus`; frozen terms normalize `expiry` to `expiredAt`, and are `null` when unfunded. Decoding requires the configured emitter, valid event data, and mined metadata; removed logs are ignored.

The reader does not establish trusted bytecode, freeze state, or fee policy. Snapshot context bytes must still be checked against the selected job and funded terms by the consumer. It never signs or broadcasts.

## Other integration surfaces

- The shared codec exports `encodeContext`, `encodeJournal`, `encodeBundle`, `referenceHash`, `keyCommitment`, and proof parsing/decryption helpers.
- The API's `createApiArcChain` installs the real reader. It returns unsigned approve/create calldata and describes the job-ID-dependent `setBudget` and `fund` steps. Funding order is create, set budget, exact approve, fund. Funding parameters are `abi.encode(imageId, rulesHash, referenceHash)`.
- The Node worker exports `createArcSettlementPort` and `runFunded`. They implement same-block preflights, durable hash/receipt separation, and capability-gated signing. See `commerce/README.md` for trust and timing requirements.
- The old `createCommerceChain`, `fundJob`, and stub ABIs remain **simulation-only**. They must not be used with the real deployment.

The earlier proposed `posterTxRequests`, `sendTx`, and `ARC_TESTNET` exports are not implemented public SDK APIs. Reference examples must not be mistaken for production exports.

## Safety boundary

A successful dummy-key release simulation returning ABI `WrongKey` only establishes that preceding checks were reachable. It does not establish payout liveness. Never simulate or estimate gas with a private release key. Sending release calldata may reveal the key even when inclusion or payout fails.

The checked-in Arc deployment records `frozen: false`. Do not infer fee/upgrade immutability from its manifest prose or the existing broadcaster-only freeze script. Worker broadcasts require operator-approved runtime/implementation/verifier pins, complete role-history validation, zero fees, and no surviving privileged role holders. Read-only inspection is not deployment approval.
