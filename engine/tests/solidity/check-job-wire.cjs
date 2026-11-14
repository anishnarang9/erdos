const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { BrowserProvider, ContractFactory, getBytes, hexlify, id } = require('ethers');
const ganache = require('ganache');
const solc = require('solc');

const pinnedRevision = 'ff30da77ba4afdd496290ebebedb205348b15d83';
const fixtures = path.resolve(__dirname, '../../fixtures');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const source = `
pragma solidity ^0.8.13;
import {ControlID,RiscZeroGroth16Verifier} from "./src/groth16/RiscZeroGroth16Verifier.sol";

contract JobWire {
    error InvalidContext();
    error InvalidVerdict();
    RiscZeroGroth16Verifier public immutable verifier = new RiscZeroGroth16Verifier(
        ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID
    );

    function keyCommitment(bytes calldata context, bytes32 key) external pure returns (bytes32) {
        return sha256(abi.encodePacked("UBC26/key/v1", context, key));
    }

    function journal(bytes calldata context, uint8 verdict, bytes calldata envelope, bytes32 commitment)
        public pure returns (bytes memory)
    {
        if (context.length != 169 || context[0] != 0x01) revert InvalidContext();
        if (verdict > 1) revert InvalidVerdict();
        return abi.encodePacked(context, verdict, sha256(envelope), commitment);
    }

    function verify(bytes calldata seal, bytes32 imageId, bytes calldata context, uint8 verdict,
        bytes calldata envelope, bytes32 commitment) external view
    {
        verifier.verify(seal, imageId, sha256(journal(context, verdict, envelope, commitment)));
    }

    function verifyPassing(bytes calldata seal, bytes32 imageId, bytes calldata context,
        bytes calldata envelope, bytes32 commitment) external view
    {
        verifier.verify(seal, imageId, sha256(journal(context, 1, envelope, commitment)));
    }
}
`;

function compile(checkout) {
    const revision = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(revision, pinnedRevision);
    // Read tracked imports directly from the pinned commit, independent of worktree edits.
    function loadImport(file) {
        try {
            const contents = file.startsWith('openzeppelin/')
                ? readFileSync(require.resolve('@' + file), 'utf8')
                : execFileSync('git', ['-C', checkout, 'show', `${pinnedRevision}:contracts/${file}`], { encoding: 'utf8' });
            return { contents };
        } catch (error) {
            return { error: error.message };
        }
    }
    const result = JSON.parse(solc.compile(JSON.stringify({
        language: 'Solidity',
        sources: { 'JobWire.sol': { content: source } },
        settings: {
            evmVersion: 'shanghai',
            optimizer: { enabled: true, runs: 200 },
            outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
    }), { import: loadImport }));
    assert.deepEqual((result.errors ?? []).filter(error => error.severity === 'error'), []);
    return result.contracts['JobWire.sol'].JobWire;
}

function flip(hex, index) {
    const bytes = getBytes(hex);
    bytes[index] ^= 1;
    return hexlify(bytes);
}

function rejectsWith(call, signature) {
    return assert.rejects(call, error => {
        assert.equal(error.code, 'CALL_EXCEPTION');
        assert.equal(error.data, id(signature).slice(0, 10));
        return true;
    });
}

async function run() {
    const [checkout, passPath = path.join(fixtures, 'scalar-proof-pass-v1.json'),
        failPath = path.join(fixtures, 'scalar-proof-fail-v1.json')] = process.argv.slice(2);
    assert.ok(checkout, 'Supply the pinned risc0-ethereum checkout and optional pass/fail proof paths');
    const artifact = compile(checkout);
    const evm = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' } });
    try {
        const provider = new BrowserProvider(evm);
        const factory = new ContractFactory(artifact.abi, artifact.evm.bytecode.object, await provider.getSigner());
        const checker = await factory.deploy();
        await checker.waitForDeployment();
        const pass = readJson(passPath);
        const fail = readJson(failPath);
        assert.equal(pass.verdict, 1);
        assert.equal(fail.verdict, 0);
        assert.equal(pass.context, fail.context);
        assert.equal(pass.imageId, fail.imageId);
        for (const proof of [pass, fail]) {
            const { seal, imageId, context, verdict, envelope, keyCommitment, journal } = proof;
            assert.equal(proof.version, 1);
            assert.equal(await checker.journal(context, verdict, envelope, keyCommitment), journal);
            await checker.verify(seal, imageId, context, verdict, envelope, keyCommitment);
        }

        const wire = readJson(path.join(fixtures, 'wire-v1.json'));
        assert.equal(wire.synthetic, true);
        assert.equal(await checker.keyCommitment(wire.context, wire.key), wire.keyCommitment);
        assert.notEqual(await checker.keyCommitment(wire.context, flip(wire.key, 0)), wire.keyCommitment);
        assert.equal(await checker.journal(wire.context, wire.verdict, wire.envelope, wire.keyCommitment), wire.journal);

        const { seal, imageId, context, envelope, keyCommitment } = pass;
        await checker.verifyPassing(seal, imageId, context, envelope, keyCommitment);
        for (const offset of [32, 52, 84, 104, 136, 168]) {
            await rejectsWith(checker.verifyPassing(seal, imageId, flip(context, offset), envelope, keyCommitment), 'VerificationFailed()');
        }
        await rejectsWith(checker.verifyPassing(seal, imageId, context, flip(envelope, 12), keyCommitment), 'VerificationFailed()');
        await rejectsWith(checker.verifyPassing(seal, imageId, context, envelope, flip(keyCommitment, 0)), 'VerificationFailed()');
        await rejectsWith(checker.verifyPassing(fail.seal, fail.imageId, fail.context, fail.envelope, fail.keyCommitment), 'VerificationFailed()');
        await rejectsWith(checker.journal(flip(context, 0), 1, envelope, keyCommitment), 'InvalidContext()');
        await rejectsWith(checker.journal(context, 2, envelope, keyCommitment), 'InvalidVerdict()');
        console.log('Accepted both reconstructed journals. Passing-only verification rejected the failing proof and changed inputs.');
    } finally {
        await evm.disconnect();
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
