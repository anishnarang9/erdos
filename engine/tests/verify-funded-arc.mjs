import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getAddress, sha256 } from 'ethers'
import { encodeSubmit } from './measure-submit-calldata.mjs'

async function run() {
  const [proofPath, requestedBlock, ...extra] = process.argv.slice(2)
  assert.ok(proofPath && !extra.length,
    'Usage: node verify-funded-arc.mjs PROOF_JSON [BLOCK_HEX]')
  const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
  assert.ok(requestedBlock === undefined || quantity.test(requestedBlock), 'Invalid block number')
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'))
  const { context, jobId, envelopeHash, envelopeBytes, data } = encodeSubmit(proof)
  const chainId = BigInt('0x' + context.subarray(1, 33).toString('hex'))
  assert.equal(chainId, 5042002n, 'Expected an Arc Testnet proof context')
  const escrow = getAddress('0x' + context.subarray(33, 53).toString('hex'))
  const provider = getAddress('0x' + context.subarray(85, 105).toString('hex'))

  const endpoint = new URL(process.env.ARC_TESTNET_RPC_URL ?? 'https://rpc.testnet.arc.io')
  let nextId = 0
  async function request(method, params) {
    const id = ++nextId
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(30000),
    })
    assert.ok(response.ok, `${method} failed with HTTP status ${response.status}`)
    const body = await response.json()
    assert.ok(body.jsonrpc === '2.0' && body.id === id, 'Invalid RPC response')
    return body
  }

  async function result(method, params) {
    const body = await request(method, params)
    assert.ok(!body.error, `${method} failed with RPC error ${Number(body.error?.code)}`)
    return body.result
  }

  assert.equal(await result('eth_chainId', []), '0x4cef52', 'Expected Arc Testnet RPC')
  const block = requestedBlock ?? await result('eth_blockNumber', [])
  assert.ok(typeof block === 'string' && quantity.test(block), 'Invalid RPC block number')
  const code = await result('eth_getCode', [escrow, block])
  assert.ok(typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(code),
    'Expected deployed escrow core code')

  const call = { from: provider, to: escrow, data }
  assert.equal(await result('eth_call', [call, block]), '0x', 'Unexpected submit return data')
  const lastSealByte = Number.parseInt(proof.seal.slice(-2), 16) ^ 1
  const changedSeal = proof.seal.slice(0, -2) + lastSealByte.toString(16).padStart(2, '0')
  const changed = encodeSubmit({ ...proof, seal: changedSeal })
  const rejected = await request('eth_call', [{ ...call, data: changed.data }, block])
  assert.ok(rejected.error?.code === 3 || /execution reverted/i.test(rejected.error?.message ?? ''),
    'Expected the deployed submit call to revert after changing the seal')

  async function estimateGas() {
    try {
      const estimate = await request('eth_estimateGas', [call, block])
      if (estimate.error) return { status: 'rpc_error', code: Number(estimate.error.code) }
      assert.match(estimate.result, quantity)
      return { status: 'estimated', gas: BigInt(estimate.result).toString() }
    } catch {
      return { status: 'request_failed' }
    }
  }

  console.log(JSON.stringify({
    mode: 'funded_submit_eth_call',
    scope: 'Simulates documented submit through the deployed core and its configured evaluator',
    rpc: endpoint.origin,
    chainId: chainId.toString(),
    block,
    escrow,
    coreRuntimeSha256: sha256(code),
    provider,
    jobId: jobId.toString(),
    imageId: proof.imageId,
    journalDigest: sha256(proof.journal),
    envelopeHash: '0x' + envelopeHash.toString('hex'),
    envelopeBytes,
    calldataBytes: (data.length - 2) / 2,
    acceptedBySimulation: true,
    changedSealReverted: true,
    estimateGas: await estimateGas(),
  }, null, 2))
}

run().catch(error => {
  console.error(error instanceof assert.AssertionError ? error.message : 'Submit preflight failed')
  process.exitCode = 1
})
