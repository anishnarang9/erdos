import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getAddress, Interface, sha256 } from 'ethers'

const [address, proofPath, requestedBlock] = process.argv.slice(2)
assert.ok(address && proofPath && process.argv.length <= 5,
  'Usage: node verify-deployed-arc.mjs VERIFIER_ADDRESS PROOF_JSON [BLOCK_HEX]')
assert.match(address, /^0x[0-9a-fA-F]{40}$/, 'Expected a verifier address in hex')
const verifier = getAddress(address)
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
if (requestedBlock !== undefined) assert.match(requestedBlock, quantity)
const proof = JSON.parse(readFileSync(proofPath, 'utf8'))
assert.match(proof.seal, /^0x[0-9a-f]{520}$/i)
const expectedSelector = '0xe71e6620'
assert.equal(proof.seal.slice(0, 10).toLowerCase(), expectedSelector)
assert.match(proof.imageId, /^0x[0-9a-f]{64}$/i)
assert.match(proof.journal, /^0x(?:[0-9a-f]{2})*$/i)
const journalDigest = sha256(proof.journal)
const abi = new Interface([
  'function SELECTOR() view returns (bytes4)',
  'function verify(bytes,bytes32,bytes32) view',
])

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
  assert.equal(body.jsonrpc, '2.0')
  assert.equal(body.id, id)
  return body
}

async function result(method, params) {
  const body = await request(method, params)
  assert.ok(!body.error, `${method} failed with RPC error ${body.error?.code}`)
  return body.result
}

assert.equal(await result('eth_chainId', []), '0x4cef52', 'Expected Arc Testnet')
const block = requestedBlock ?? await result('eth_blockNumber', [])
assert.match(block, quantity)
const code = await result('eth_getCode', [verifier, block])
assert.match(code, /^0x(?:[0-9a-f]{2})+$/i, 'Expected deployed verifier code')
const returnedSelector = await result('eth_call', [
  { to: verifier, data: abi.encodeFunctionData('SELECTOR') }, block,
])
assert.equal(abi.decodeFunctionResult('SELECTOR', returnedSelector)[0], expectedSelector)
const call = {
  to: verifier,
  data: abi.encodeFunctionData('verify', [proof.seal, proof.imageId, journalDigest]),
}
assert.equal(await result('eth_call', [call, block]), '0x')

async function estimateGas() {
  try {
    const estimate = await request('eth_estimateGas', [call, block])
    if (estimate.error) return { status: 'rpc_error', code: estimate.error.code }
    assert.match(estimate.result, quantity)
    return { status: 'estimated', gas: BigInt(estimate.result).toString() }
  } catch {
    return { status: 'request_failed' }
  }
}
console.log(JSON.stringify({
  mode: 'direct_deployed_verifier_eth_call',
  scope: 'Direct verifier call and gas estimate',
  rpc: endpoint.origin,
  chainId: '5042002',
  block,
  verifier,
  runtimeSha256: sha256(code),
  selector: expectedSelector,
  imageId: proof.imageId,
  journalDigest,
  accepted: true,
  estimateGas: await estimateGas(),
}, null, 2))
