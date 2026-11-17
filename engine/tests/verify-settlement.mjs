// LOCAL ONLY. Run: node engine/tests/verify-settlement.mjs
// Full release/decryption: append --private-root /path/to/ubc26-integration-new-proofs
// No key is embedded, printed, persisted, or accepted in argv. No external RPC is supported.
// Synthetic receipt addresses are installed ONLY in this disposable Anvil; this is NOT
// evidence of a fresh/live funded context. Contracts come from Nick's immutable git pin,
// not the possibly modified/untracked contracts worktree. No mock proof verifier is used.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import solc from 'solc'
import { AbiCoder, Contract, ContractFactory, JsonRpcProvider, getAddress, id, sha256, concat, version } from 'ethers'
import { encodeSubmit } from './measure-submit-calldata.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pin = '80c8a4af68f0cf00e4177c98e9c435d869716edd'
const abi = AbiCoder.defaultAbiCoder()
const hex = b => '0x' + Buffer.from(b).toString('hex')
const bytes = h => Buffer.from(h.slice(2), 'hex')
const flip = (h, offset = 0) => { const b = bytes(h); b[offset] ^= 1; return hex(b) }
const json = p => JSON.parse(readFileSync(p, 'utf8'))
let stage = 'arguments', child, provider, key, passed = 0
const started = Date.now()
const checks = []
// Also tear down on interruption; never leave a node holding release calldata alive.
process.once('exit', () => { key?.fill(0); child?.kill('SIGKILL') })
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))
async function check(name, fn) {
  stage = name
  await fn()
  checks.push(name)
  passed++
  console.log(`ok ${passed} - ${name}`)
}
function pinned(path) {
  return execFileSync('git', ['show', `${pin}:contracts/${path}`], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  })
}
function compile() {
  assert.match(solc.version(), /^0\.8\.30\+/)
  assert.equal(version, '6.15.0')
  const files = ['src/core/src/AgenticCommercePatched.sol', 'src/SettlementHook.sol',
    'src/core/lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol',
    'src/verifier/groth16/RiscZeroGroth16Verifier.sol', 'test/mocks/MockUSDC.sol']
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: Object.fromEntries(files.map(f => [f, { content: pinned(f) }])),
    settings: {
      evmVersion: 'cancun', optimizer: { enabled: false },
      remappings: pinned('remappings.txt').trim().split(/\s+/),
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }), { import: f => {
    try { return { contents: pinned(f) } } catch { return { error: 'Pinned import unavailable: ' + f } }
  } }))
  const errors = (output.errors ?? []).filter(e => e.severity === 'error')
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'))
  const names = ['AgenticCommerce', 'SettlementHook', 'ERC1967Proxy', 'RiscZeroGroth16Verifier', 'MockUSDC']
  return Object.fromEntries(files.map((f, i) => [names[i], output.contracts[f][names[i]]]))
}
async function main() {
  const { values } = parseArgs({ options: { 'private-root': { type: 'string' } } })
  const privateRoot = values['private-root'] ?? process.env.UBC26_SETTLEMENT_PRIVATE_ROOT
  const fixtures = join(root, 'engine/evaluation/proofs/ledger-reconciliation')
  const pass = json(join(fixtures, 'proof-pass.json'))
  const fail = json(join(fixtures, 'proof-fail.json'))
  const wire = encodeSubmit(pass)
  encodeSubmit(fail, 0)
  assert.equal(pass.context, fail.context)
  assert.equal(pass.imageId, fail.imageId)
  const ctx = bytes(pass.context)
  assert.equal(BigInt(hex(ctx.subarray(1, 33))), 5042002n)
  const escrow = getAddress(hex(ctx.subarray(33, 53)))
  const solver = getAddress(hex(ctx.subarray(85, 105)))
  assert.equal(escrow, '0x' + '11'.repeat(20))
  assert.equal(solver, '0x' + '22'.repeat(20))
  const jobId = wire.jobId
  assert.equal(jobId, 5002n) // Bound the sequential fixture setup; never patch jobCounter.
  const rules = hex(ctx.subarray(105, 137)), reference = hex(ctx.subarray(137, 169))
  if (privateRoot) {
    stage = 'private fixture pairing (contents suppressed)'
    const family = join(resolve(privateRoot), 'ledger-reconciliation')
    assert.deepEqual(json(join(family, 'pass-proof/proof.json')), pass)
    assert.deepEqual(json(join(family, 'fail-proof/proof.json')), fail)
    const text = readFileSync(join(family, 'pass-proof/release-key.hex'), 'utf8').trim()
    if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(text)) throw new Error('Invalid private key format')
    key = Buffer.from(text.replace(/^0x/, ''), 'hex')
    if (sha256(concat([Buffer.from('UBC26/key/v1'), ctx, key])) !== pass.keyCommitment)
      throw new Error('Private key does not match published receipt')
  }
  stage = 'compile pinned actual contracts'
  const artifacts = compile()
  const req = createRequire(join(root, 'commerce/sdk/package.json'))
  const mainPkg = req.resolve('@foundry-rs/anvil/package.json')
  assert.equal(json(mainPkg).version, '1.7.1')
  const platformReq = createRequire(mainPkg)
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const bin = join(dirname(platformReq.resolve(`@foundry-rs/anvil-${process.platform}-${arch}/package.json`)), 'bin/anvil')
  // --port 0 lets the OS choose the port atomically. Ignore inherited RPC/config env.
  child = spawn(bin, ['--host', '127.0.0.1', '--port', '0', '--chain-id', '5042002',
    '--hardfork', 'cancun', '--timestamp', '1700000000', '--config-out', '/dev/null'], {
    cwd: '/tmp', env: { PATH: process.env.PATH, HOME: '/tmp' }, stdio: ['ignore', 'pipe', 'ignore'],
  })
  let output = '', spawnFailed = false
  child.on('error', () => { spawnFailed = true })
  // Startup includes throwaway account keys: consume internally; never print it.
  child.stdout.on('data', d => { output = (output + d.toString()).slice(-32768) })
  stage = 'start disposable loopback Anvil Cancun'
  let port
  for (let i = 0; i < 200; i++) {
    port = output.match(/Listening on 127\.0\.0\.1:(\d+)/)?.[1]
    if (port) break
    if (spawnFailed || child.exitCode !== null) throw new Error('Anvil startup failed')
    await delay(50)
  }
  if (!port) throw new Error('Anvil startup timed out')
  const endpoint = `http://127.0.0.1:${port}`
  provider = new JsonRpcProvider(endpoint, 5042002, { cacheTimeout: -1, batchMaxCount: 1 })
  provider.pollingInterval = 20
  let requestId = 0
  async function rpc(method, params = []) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('Local RPC HTTP failure')
    const body = await response.json()
    if (body.error) throw new Error('Local RPC failed: ' + method)
    return body.result
  }
  const accounts = await rpc('eth_accounts')
  const poster = getAddress(accounts[0]), treasury = getAddress(accounts[1])
  const signer = await provider.getSigner(poster)
  async function deploy(name, args = []) {
    stage = 'deploy ' + name
    const a = artifacts[name]
    const c = await new ContractFactory(a.abi, '0x' + a.evm.bytecode.object, signer).deploy(...args)
    await c.waitForDeployment()
    return c
  }
  async function sent(tx) { return (await tx).wait(1, 15000) }
  await check('isolated Anvil chain 5042002', async () => {
    assert.equal(BigInt(await rpc('eth_chainId')), 5042002n)
    assert.match(await rpc('web3_clientVersion'), /anvil/i)
    assert.equal(BigInt(await rpc('eth_blockNumber')), 0n)
  })
  stage = 'deploy actual verifier, token, proxy and hook'
  const control = pinned('src/verifier/groth16/ControlID.sol')
  const constants = [...control.matchAll(/hex"([0-9a-f]{64})"/g)].map(m => '0x' + m[1])
  assert.equal(constants.length, 2)
  const verifier = await deploy('RiscZeroGroth16Verifier', constants)
  const token = await deploy('MockUSDC')
  const impl = await deploy('AgenticCommerce')
  const proxy = await deploy('ERC1967Proxy', [impl.target,
    impl.interface.encodeFunctionData('initialize', [token.target, treasury, poster])])
  stage = 'install local synthetic proxy runtime'
  await rpc('anvil_setCode', [escrow, await provider.getCode(proxy.target)])
  // Only the ERC1967 implementation pointer is artificial; initialize and all job
  // state/funding/transitions are genuine calls. No job/terms/token storage overrides.
  await rpc('anvil_setStorageAt', [escrow,
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    '0x' + impl.target.slice(2).padStart(64, '0')])
  const core = new Contract(escrow, artifacts.AgenticCommerce.abi, signer)
  await sent(core.initialize(token.target, treasury, poster))
  const hook = await deploy('SettlementHook', [escrow, verifier.target, token.target, 16412, 600])
  await sent(core.setHookWhitelist(hook.target, true))
  await rpc('anvil_impersonateAccount', [solver])
  await rpc('anvil_setBalance', [solver, '0x56bc75e2d63100000'])
  // JsonRpcSigner avoids requiring the impersonated account in eth_accounts.
  const { JsonRpcSigner } = await import('ethers')
  const solverSigner = new JsonRpcSigner(provider, solver)
  const solverCore = core.connect(solverSigner), solverHook = hook.connect(solverSigner)
  const budget = 25000000n, initial = 100000000n, expiry = 1700086400
  await sent(token.mint(poster, initial))
  const status = async n => (await core.getJob(n)).status
  const balances = async () => Promise.all([poster, solver, escrow, hook.target, treasury].map(a => token.balanceOf(a)))
  const opts = p => abi.encode(['bytes', 'bytes', 'bytes32'], [p.envelope, p.seal, p.keyCommitment])
  const submit = (p, n = jobId) => solverCore.submit(n, sha256(p.envelope), opts(p), { gasLimit: 3000000 })
  function events(receipt, contract, name) {
    return receipt.logs.filter(l => l.address.toLowerCase() === contract.target.toLowerCase())
      .map(l => { try { return contract.interface.parseLog(l) } catch { return null } })
      .filter(l => l?.name === name)
  }
  async function rejects(call, signature) {
    let caught
    try { await call() } catch (e) { caught = e }
    assert.ok(caught && caught.code === 'CALL_EXCEPTION', 'Expected EVM revert, not transport failure')
    assert.equal(caught.data?.slice(0, 10), id(signature).slice(0, 10))
  }
  async function revertedTx(contract, name, args) {
    const hash = await rpc('eth_sendTransaction', [{ from: solver, to: contract.target,
      data: contract.interface.encodeFunctionData(name, args), gas: '0x2dc6c0' }])
    let receipt
    for (let retry = 0; retry < 200; retry++) {
      receipt = await rpc('eth_getTransactionReceipt', [hash])
      if (receipt) break
      await delay(10)
    }
    assert.equal(receipt?.status, '0x0')
    assert.equal(receipt.logs.length, 0)
  }
  await check('real Groth16 verifier accepts both original verdict journals', async () => {
    assert.equal(await verifier.SELECTOR(), '0xe71e6620')
    for (const p of [pass, fail]) await verifier.verify(p.seal, p.imageId, sha256(p.journal))
  })
  for (const [name, seal, image, digest] of [
    ['mutated seal', flip(pass.seal, 259), pass.imageId, sha256(pass.journal)],
    ['wrong image', pass.seal, flip(pass.imageId), sha256(pass.journal)],
    ['mutated journal', pass.seal, pass.imageId, sha256(flip(pass.journal, 84))],
  ]) await check(`real verifier rejects ${name}`, () => rejects(() => verifier.verify(seal, image, digest), 'VerificationFailed()'))
  await check('create sequential real jobs through receipt jobId (no counter override)', async () => {
    // Batch only filler creates; each still executes an actual core transaction.
    const data = core.interface.encodeFunctionData('createJob', [solver, poster, expiry, 'local filler', '0x' + '00'.repeat(20)])
    for (let first = 1; first < Number(jobId); first += 100) {
      const count = Math.min(100, Number(jobId) - first)
      const nonce = BigInt(await rpc('eth_getTransactionCount', [poster, 'pending']))
      const batch = Array.from({ length: count }, (_, i) => ({ jsonrpc: '2.0', id: ++requestId,
        method: 'eth_sendTransaction', params: [{ from: poster, to: escrow, data, gas: '0x7a120',
          nonce: '0x' + (nonce + BigInt(i)).toString(16) }] }))
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch), signal: AbortSignal.timeout(30000) })
      assert.ok(response.ok)
      const results = await response.json()
      assert.equal(results.length, count)
      assert.ok(results.every(r => !r.error && /^0x[0-9a-f]{64}$/.test(r.result)))
      stage = `mine filler batch starting ${first}`
      for (const result of results) {
        let receipt
        for (let retry = 0; retry < 200; retry++) {
          receipt = await rpc('eth_getTransactionReceipt', [result.result])
          if (receipt) break
          await delay(10)
        }
        assert.equal(receipt?.status, '0x1')
      }
      assert.equal(await core.jobCounter(), BigInt(first + count - 1))
    }
    stage = 'create receipt-bound job 5002'
    assert.equal(await core.jobCounter(), jobId - 1n)
    await sent(core.createJob(solver, hook.target, expiry, 'LOCAL artificial receipt-address fixture', hook.target))
    assert.equal(await core.jobCounter(), jobId)
  })
  await check('actual ERC20 funding freezes exact receipt context and terms', async () => {
    await sent(core.setBudget(jobId, budget, '0x'))
    await sent(token.approve(escrow, budget))
    const receipt = await sent(core.fund(jobId, abi.encode(['bytes32', 'bytes32', 'bytes32'], [pass.imageId, rules, reference])))
    assert.equal(events(receipt, hook, 'TermsFrozen').length, 1)
    assert.equal(await hook.contextOf(jobId), pass.context)
    const t = await hook.terms(jobId)
    assert.deepEqual(Array.from(t), [pass.imageId, rules, reference, solver, budget, BigInt(expiry), true])
    assert.deepEqual(await balances(), [initial - budget, 0n, budget, 0n, 0n])
    assert.equal(await token.allowance(poster, escrow), 0n)
    assert.equal(await status(jobId), 1n)
    const expected = await hook.expectedJournal(jobId, sha256(pass.envelope), pass.keyCommitment)
    assert.equal(expected[0], pass.journal)
    assert.equal(expected[1], sha256(pass.journal))
  })
  const fundedSnapshot = await rpc('evm_snapshot')
  async function unchangedFunded() {
    assert.equal(await status(jobId), 1n)
    assert.equal((await hook.submissions(jobId)).accepted, false)
    assert.equal(await hook.released(jobId), false)
    assert.deepEqual(await balances(), [initial - budget, 0n, budget, 0n, 0n])
  }
  await check('verdict-zero real receipt rejected on-chain without payout or logs', async () => {
    await rejects(() => solverCore.submit.staticCall(jobId, sha256(fail.envelope), opts(fail)), 'VerificationFailed()')
    await revertedTx(core, 'submit', [jobId, sha256(fail.envelope), opts(fail)])
    await unchangedFunded()
  })
  await check('mutated ciphertext with recomputed envelope hash rejected cryptographically', async () => {
    const p = { ...pass, envelope: flip(pass.envelope, 12) }
    await rejects(() => solverCore.submit.staticCall(jobId, sha256(p.envelope), opts(p)), 'VerificationFailed()')
    await revertedTx(core, 'submit', [jobId, sha256(p.envelope), opts(p)])
    await unchangedFunded()
  })
  await check('envelope hash mismatch rejected before verifier', async () => {
    await rejects(() => solverCore.submit.staticCall(jobId, flip(sha256(pass.envelope)), opts(pass)), 'EnvelopeHashMismatch()')
    await unchangedFunded()
  })
  await check('permissionless Funded refund at exact expiry', async () => {
    await rejects(() => core.claimRefund.staticCall(jobId), 'WrongStatus()')
    await rpc('evm_setNextBlockTimestamp', [expiry]); await rpc('evm_mine')
    await rejects(() => solverCore.submit.staticCall(jobId, sha256(pass.envelope), opts(pass)), 'Expired()')
    const receipt = await sent(core.connect(await provider.getSigner(treasury)).claimRefund(jobId, { gasLimit: 500000 }))
    assert.equal(events(receipt, core, 'Refunded')[0].args.amount, budget)
    assert.equal(await status(jobId), 5n)
    assert.deepEqual(await balances(), [initial, 0n, 0n, 0n, 0n])
    await rejects(() => core.claimRefund.staticCall(jobId), 'WrongStatus()')
    assert.equal(await rpc('evm_revert', [fundedSnapshot]), true)
    await unchangedFunded()
  })
  await check('passing actual receipt accepted, no payment before key release', async () => {
    const receipt = await sent(submit(pass))
    assert.equal(events(receipt, hook, 'ProofAccepted').length, 1)
    assert.equal(events(receipt, core, 'JobSubmitted').length, 1)
    assert.equal(events(receipt, core, 'PaymentReleased').length, 0)
    assert.equal(await status(jobId), 2n)
    assert.deepEqual(Array.from(await hook.submissions(jobId)), [sha256(pass.envelope), pass.keyCommitment, true])
    assert.deepEqual(await balances(), [initial - budget, 0n, budget, 0n, 0n])
  })
  await check('same-job submission replay rejected', () => rejects(
    () => solverCore.submit.staticCall(jobId, sha256(pass.envelope), opts(pass)), 'WrongStatus()'))
  await check('cross-job replay rejected by actual verifier', async () => {
    const checkpoint = await rpc('evm_snapshot')
    const next = jobId + 1n
    await sent(core.createJob(solver, hook.target, expiry, 'local replay target', hook.target))
    await sent(core.setBudget(next, budget, '0x')); await sent(token.approve(escrow, budget))
    await sent(core.fund(next, abi.encode(['bytes32', 'bytes32', 'bytes32'], [pass.imageId, rules, reference])))
    await rejects(() => solverCore.submit.staticCall(next, sha256(pass.envelope), opts(pass)), 'VerificationFailed()')
    assert.equal(await status(next), 1n)
    assert.equal(await rpc('evm_revert', [checkpoint]), true)
  })
  const submittedSnapshot = await rpc('evm_snapshot')
  await check('wrong release key rejected without payout or release flag', async () => {
    const wrong = key ? flip(hex(key)) : '0x' + '00'.repeat(32)
    await rejects(() => solverHook.release.staticCall(jobId, wrong), 'WrongKey()')
    await revertedTx(hook, 'release', [jobId, wrong])
    assert.equal(await hook.released(jobId), false)
    assert.equal(await status(jobId), 2n)
    assert.deepEqual(await balances(), [initial - budget, 0n, budget, 0n, 0n])
  })
  if (key) {
    await check('private key release pays exact ERC20 budget and emits settlement events', async () => {
      await rejects(() => hook.release.staticCall(jobId, hex(key)), 'NotProvider()')
      const receipt = await sent(solverHook.release(jobId, hex(key), { gasLimit: 1000000 }))
      const paid = events(receipt, core, 'PaymentReleased')
      assert.equal(paid.length, 1)
      assert.equal(paid[0].args.jobId, jobId)
      assert.equal(paid[0].args.provider, solver)
      assert.equal(paid[0].args.amount, budget)
      const completed = events(receipt, core, 'JobCompleted')
      assert.equal(completed.length, 1)
      assert.equal(completed[0].args.reason, pass.keyCommitment)
      const released = events(receipt, hook, 'KeyReleased')
      assert.equal(released.length, 1)
      assert.equal(released[0].args.envelopeHash, sha256(pass.envelope))
      if (released[0].args.key !== hex(key)) throw new Error('Released key mismatch')
      assert.equal(await hook.released(jobId), true)
      assert.equal(await status(jobId), 3n)
      assert.deepEqual(await balances(), [initial - budget, budget, 0n, 0n, 0n])
      assert.equal(await token.totalSupply(), initial)
      await rejects(() => solverHook.release.staticCall(jobId, hex(key)), 'AlreadyReleased()')
      await revertedTx(hook, 'release', [jobId, hex(key)])
      assert.deepEqual(await balances(), [initial - budget, budget, 0n, 0n, 0n])
      await rejects(() => core.claimRefund.staticCall(jobId), 'WrongStatus()')
    })
    await check('released key decrypts exact original files; AEAD rejects key/context/ciphertext mutations', async () => {
      function decrypt(envelope, context, releaseKey) {
        const e = bytes(envelope)
        const d = createDecipheriv('chacha20-poly1305', releaseKey, e.subarray(0, 12), { authTagLength: 16 })
        d.setAAD(bytes(context)); d.setAuthTag(e.subarray(-16))
        return Buffer.concat([d.update(e.subarray(12, -16)), d.final()])
      }
      const bundle = decrypt(pass.envelope, pass.context, key)
      let offset = 0
      function take(n) { assert.ok(offset + n <= bundle.length); const b = bundle.subarray(offset, offset + n); offset += n; return b }
      assert.equal(take(1)[0], 1)
      const count = take(2).readUInt16BE()
      const originalDir = join(fixtures, 'pass/delivery')
      const originals = readdirSync(originalDir).sort()
      assert.equal(count, originals.length)
      for (const expected of originals) {
        const name = take(take(2).readUInt16BE()).toString('utf8')
        assert.equal(name, expected)
        const contents = take(take(4).readUInt32BE())
        assert.deepEqual(contents, readFileSync(join(originalDir, expected)))
      }
      assert.equal(offset, bundle.length)
      assert.throws(() => decrypt(pass.envelope, pass.context, bytes(flip(hex(key)))))
      assert.throws(() => decrypt(pass.envelope, flip(pass.context, 84), key))
      assert.throws(() => decrypt(flip(pass.envelope, 12), pass.context, key))
    })
  }
  await check('permissionless Submitted refund at exact expiry; late release rejected', async () => {
    assert.equal(await rpc('evm_revert', [submittedSnapshot]), true)
    assert.equal(await status(jobId), 2n)
    await rejects(() => core.claimRefund.staticCall(jobId), 'WrongStatus()')
    await rpc('evm_setNextBlockTimestamp', [expiry]); await rpc('evm_mine')
    await rejects(() => solverHook.release.staticCall(jobId, key ? hex(key) : '0x' + '00'.repeat(32)), 'Expired()')
    const receipt = await sent(core.connect(await provider.getSigner(treasury)).claimRefund(jobId, { gasLimit: 500000 }))
    assert.equal(events(receipt, core, 'Refunded')[0].args.amount, budget)
    assert.equal(events(receipt, core, 'JobExpired').length, 1)
    assert.equal(await status(jobId), 5n)
    assert.equal(await hook.released(jobId), false)
    assert.deepEqual(await balances(), [initial, 0n, 0n, 0n, 0n])
    await rejects(() => core.claimRefund.staticCall(jobId), 'WrongStatus()')
  })
  if (key) key.fill(0)
  console.log(JSON.stringify({ passed, failed: 0, elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    pin, solc: solc.version(), ethers: version,
    mode: privateRoot ? 'local-full-settlement' : 'local-public-receipt-regression',
    skipped: privateRoot ? [] : ['correct-key payout/duplicate release', 'exact-file decryption (requires --private-root)'],
    limitation: 'LOCAL artificial address fixture: proxy runtime/implementation pointer installed at synthetic 0x1111 escrow; 0x2222 provider impersonated; mock ERC20 minted. Real pinned core/hook/verifier; no fork/public RPC/live deployment; no fresh proving.',
    checks }, null, 2))
}

// Never print exception objects: ethers errors can contain release calldata/keys.
const watchdog = setTimeout(() => { child?.kill('SIGKILL'); console.error('FAIL: local test exceeded 9 minutes'); process.exit(1) }, 540000)
try {
  await main()
} catch {
  console.error(`FAIL at ${stage} (details suppressed to protect private key/calldata)`)
  console.error(JSON.stringify({ passed, failed: 1, stage }))
  process.exitCode = 1
} finally {
  key?.fill(0)
  clearTimeout(watchdog)
  provider?.destroy()
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r))
    child.kill('SIGTERM')
    const killer = setTimeout(() => child.kill('SIGKILL'), 2000)
    await exited
    clearTimeout(killer)
  }
}
