import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(new URL('wire-v1.json', import.meta.url), 'utf8'))

function decodeHex(value) {
  assert.match(value, /^0x(?:[0-9a-f]{2})*$/)
  return Buffer.from(value.slice(2), 'hex')
}

function unsignedBigEndian(value, width) {
  const hex = BigInt(value).toString(16)
  assert.match(hex, /^[0-9a-f]+$/)
  assert.ok(hex.length <= width * 2)
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex')
}

function sha256(...parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

assert.equal(fixture.version, 1)
assert.equal(fixture.synthetic, true)
assert.equal(fixture.verdict, 1)

const fields = fixture.contextFields
const context = Buffer.concat([
  Buffer.from([fixture.version]),
  unsignedBigEndian(fields.chainId, 32),
  decodeHex(fields.escrow),
  unsignedBigEndian(fields.jobId, 32),
  decodeHex(fields.provider),
  decodeHex(fields.rulesHash),
  decodeHex(fields.referenceHash),
])
assert.equal(context.length, 169)

const files = fixture.files.map(({ name, contents }) => ({
  name: Buffer.from(name, 'ascii'),
  contents: decodeHex(contents),
}))
files.sort((a, b) => Buffer.compare(a.name, b.name))
const bundle = Buffer.concat([
  Buffer.from([fixture.version]),
  unsignedBigEndian(files.length, 2),
  ...files.flatMap(({ name, contents }) => [
    unsignedBigEndian(name.length, 2),
    name,
    unsignedBigEndian(contents.length, 4),
    contents,
  ]),
])

const key = decodeHex(fixture.key)
const nonce = decodeHex(fixture.nonce)
assert.equal(key.length, 32)
assert.equal(nonce.length, 12)

const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
cipher.setAAD(context)
const ciphertext = Buffer.concat([cipher.update(bundle), cipher.final()])
const envelope = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])
const envelopeHash = sha256(envelope)
const keyCommitment = sha256(Buffer.from('UBC26/key/v1', 'ascii'), context, key)
const journal = Buffer.concat([context, Buffer.from([fixture.verdict]), envelopeHash, keyCommitment])
const journalDigest = sha256(journal)
assert.equal(journal.length, 234)

const expectedBytes = { context, bundle, envelope, envelopeHash, keyCommitment, journal, journalDigest }
for (const [name, bytes] of Object.entries(expectedBytes)) {
  assert.deepEqual(bytes, decodeHex(fixture[name]), name)
}

function decrypt(associatedData) {
  const storedKey = decodeHex(fixture.key)
  const storedEnvelope = decodeHex(fixture.envelope)
  const decipher = createDecipheriv('chacha20-poly1305', storedKey, storedEnvelope.subarray(0, 12), {
    authTagLength: 16,
  })
  decipher.setAAD(associatedData)
  decipher.setAuthTag(storedEnvelope.subarray(-16))
  return Buffer.concat([decipher.update(storedEnvelope.subarray(12, -16)), decipher.final()])
}

assert.deepEqual(decrypt(context), bundle)
const modifiedContext = Buffer.from(context)
modifiedContext[84] ^= 1 // Change the last byte of the job ID.
assert.throws(() => decrypt(modifiedContext), /authenticate/)
console.log('Wire v1 fixture passed.')
