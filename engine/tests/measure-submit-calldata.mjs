import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { AbiCoder, Interface, getBytes } from 'ethers'

function bytes(value, name, size) {
  assert.match(value, /^0x(?:[0-9a-f]{2})+$/, `Invalid ${name} hex`)
  const result = Buffer.from(value.slice(2), 'hex')
  if (size !== undefined) assert.equal(result.length, size, `Invalid ${name} length`)
  return result
}

export function encodeSubmit(proof) {
  assert.equal(proof.version, 1)
  assert.equal(proof.verdict, 1, 'Submit calldata requires a passing journal')
  bytes(proof.imageId, 'imageId', 32)
  const context = bytes(proof.context, 'context', 169)
  assert.equal(context[0], 1, 'Invalid funded context version')
  const jobId = BigInt(`0x${context.subarray(53, 85).toString('hex')}`)
  const envelope = bytes(proof.envelope, 'envelope')
  const envelopeOverhead = 12 + 16
  const bundleBytes = envelope.length - envelopeOverhead
  const maxBundleBytes = 16 * 1024
  assert.ok(bundleBytes >= 3 && bundleBytes <= maxBundleBytes, 'Invalid delivery bundle size')
  const envelopeHash = createHash('sha256').update(envelope).digest()
  const keyCommitment = bytes(proof.keyCommitment, 'keyCommitment', 32)
  const seal = bytes(proof.seal, 'seal', 260)
  assert.equal(seal.subarray(0, 4).toString('hex'), 'e71e6620')
  assert.deepEqual(bytes(proof.journal, 'journal', 234), Buffer.concat([
    context, Buffer.from([1]), envelopeHash, keyCommitment,
  ]), 'Journal differs from the public proof fields')

  const submit = new Interface(['function submit(uint256,bytes32,bytes)'])
  const optParams = AbiCoder.defaultAbiCoder().encode(
    ['bytes', 'bytes', 'bytes32'], [proof.envelope, proof.seal, proof.keyCommitment],
  )
  const data = submit.encodeFunctionData('submit', [jobId, envelopeHash, optParams])
  return { context, jobId, bundleBytes, maxBundleBytes, envelopeBytes: envelope.length, envelopeHash, data }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [proofPath] = process.argv.slice(2)
  assert.equal(process.argv.length, 3, 'Usage: node measure-submit-calldata.mjs PROOF_JSON')
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'))
  const { jobId, bundleBytes, maxBundleBytes, envelopeBytes, data } = encodeSubmit(proof)
  const calldata = getBytes(data)
  const zeroBytes = calldata.reduce((count, byte) => count + Number(byte === 0), 0)
  const nonzeroBytes = calldata.length - zeroBytes
  const gasPerZeroByte = 4
  const gasPerNonzeroByte = 16

  console.log(JSON.stringify({
    mode: 'offline_documented_submit_calldata',
    jobId: jobId.toString(),
    bundleBytes,
    maxBundleBytes,
    envelopeBytes,
    calldataBytes: calldata.length,
    zeroBytes,
    nonzeroBytes,
    gasPerZeroByte,
    gasPerNonzeroByte,
    intrinsicCalldataGas: zeroBytes * gasPerZeroByte + nonzeroBytes * gasPerNonzeroByte,
  }, null, 2))
}
