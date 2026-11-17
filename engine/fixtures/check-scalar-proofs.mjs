import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const passed = read(process.argv[2] ?? new URL('scalar-proof-pass-v1.json', import.meta.url))
const failed = read(process.argv[3] ?? new URL('scalar-proof-fail-v1.json', import.meta.url))

function bytes(hex, size) {
  assert.match(hex, /^0x(?:[0-9a-f]{2})+$/)
  const result = Buffer.from(hex.slice(2), 'hex')
  if (size !== undefined) assert.equal(result.length, size)
  return result
}

for (const [verdict, proof] of [failed, passed].entries()) {
  assert.equal(proof.version, 1)
  assert.equal(proof.verdict, verdict)
  assert.equal(bytes(proof.seal, 260).subarray(0, 4).toString('hex'), 'e71e6620')
  bytes(proof.imageId, 32)
  const context = bytes(proof.context, 169)
  const envelopeHash = createHash('sha256').update(bytes(proof.envelope)).digest()
  assert.deepEqual(bytes(proof.journal, 234), Buffer.concat([
    context, Buffer.from([verdict]), envelopeHash, bytes(proof.keyCommitment, 32),
  ]))
}

assert.equal(passed.imageId, failed.imageId)
assert.equal(passed.context, failed.context)
assert.notEqual(passed.envelope, failed.envelope)
assert.notEqual(passed.keyCommitment, failed.keyCommitment)
assert.notEqual(passed.seal, failed.seal)
console.log('Scalar proof fixture journals match their public inputs.')
