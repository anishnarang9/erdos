const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserProvider, Contract, ContractFactory, getBytes, hexlify, id, sha256 } = require('ethers');
const ganache = require('ganache');
const solc = require('solc');

const {execFileSync}=require('node:child_process');
const [sourceRoot,proofPath,runtimeExport]=process.argv.slice(2);
assert.ok(sourceRoot,'Supply a checkout of risc0-ethereum v3.1.0 and optional proof JSON');
const revision=execFileSync('git',['-C',sourceRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(revision,'ff30da77ba4afdd496290ebebedb205348b15d83');
execFileSync('git',['-C',sourceRoot,'diff','--exit-code','HEAD','--','contracts/src','contracts/test/TestReceiptV3_1.sol'],{stdio:'pipe'});
const contractDir=path.resolve(sourceRoot,'contracts');
const source = `
pragma solidity ^0.8.13;
import {ControlID,RiscZeroGroth16Verifier} from "./src/groth16/RiscZeroGroth16Verifier.sol";
import {TestReceipt} from "./test/TestReceiptV3_1.sol";

contract Smoke {
    RiscZeroGroth16Verifier public immutable verifier = new RiscZeroGroth16Verifier(
        ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID
    );
    function selector() external view returns (bytes4) {
        require(bytes4(TestReceipt.SEAL) == verifier.SELECTOR());
        return verifier.SELECTOR();
    }
    function valid() external view {
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID, sha256(TestReceipt.JOURNAL));
    }
    function invalidImage() external view {
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID ^ bytes32(uint256(1)), sha256(TestReceipt.JOURNAL));
    }
    function invalidJournal() external view {
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID, sha256(TestReceipt.JOURNAL) ^ bytes32(uint256(1)));
    }
    function invalidSeal() external view {
        bytes memory seal = TestReceipt.SEAL;
        seal[4] ^= bytes1(uint8(1));
        verifier.verify(seal, TestReceipt.IMAGE_ID, sha256(TestReceipt.JOURNAL));
    }
}
`;
function loadImport(file) {
    const resolved = file.startsWith('openzeppelin/')
        ? require.resolve('@' + file) : path.join(contractDir, file);
    try { return { contents: fs.readFileSync(resolved, 'utf8') }; }
    catch (error) { return { error: error.message }; }
}
const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Smoke.sol': { content: source } },
    settings: {
        evmVersion: 'shanghai',
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
}), { import: loadImport }));
const errors = (output.errors || []).filter(error => error.severity === 'error');
assert.deepEqual(errors, []);
const artifact = output.contracts['Smoke.sol'].Smoke;
const evm = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' } });
async function run() {
    const provider = new BrowserProvider(evm);
    const signer = await provider.getSigner();
    const factory = new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    if (runtimeExport) {
        fs.writeFileSync(runtimeExport, await provider.getCode(await contract.verifier()));
    }
    const selector = await contract.selector();
    assert.equal(selector, '0xe71e6620');
    console.log('verification environment', 'local Ganache (Shanghai)');
    console.log('verifier SELECTOR', selector);
    console.log('verify(bytes,bytes32,bytes32) ABI selector', id('verify(bytes,bytes32,bytes32)').slice(0,10));
    if (proofPath) {
        await checkFresh(await contract.verifier(), signer, selector, proofPath);
        return;
    }
    await contract.valid();
    console.log('valid', 'accepted');
    const verificationFailed = id('VerificationFailed()').slice(0, 10);
    for (const method of ['invalidImage', 'invalidJournal', 'invalidSeal']) {
        await assert.rejects(contract[method](), error => {
            assert.equal(error.code, 'CALL_EXCEPTION');
            assert.equal(error.data, verificationFailed);
            return true;
        });
        console.log(method, 'reverted', verificationFailed);
    }
}
async function checkFresh(address, signer, selector, file) {
    const fileText = fs.readFileSync(file, 'utf8');
    const receipt = [fileText, ...fileText.split(/\r?\n/)].map(value => {
        try { return JSON.parse(value); }
        catch { return null; }
    }).find(value => value?.seal);
    assert.ok(receipt, 'Expected a JSON line with a seal');
    const imageId = receipt.imageId ?? receipt.image_id;
    const journal = receipt.journal;
    const seal = receipt.seal;
    assert.match(imageId, /^0x[0-9a-f]{64}$/i);
    assert.match(journal, /^0x(?:[0-9a-f]{2})*$/i);
    assert.match(seal, /^0x[0-9a-f]{520}$/i);
    assert.equal(seal.slice(0, 10).toLowerCase(), selector);
    const digest = sha256(journal);
    const verifier = new Contract(address,
        ['function verify(bytes,bytes32,bytes32) view'], signer);
    await verifier.verify(seal, imageId, digest);
    console.log('verify gas estimate', (await verifier.verify.estimateGas(seal, imageId, digest)).toString());
    console.log('fresh accepted', 'imageId', imageId, 'journalDigest', digest);
    const mutate = (hex, index) => {
        const bytes = getBytes(hex);
        bytes[index] ^= 1;
        return hexlify(bytes);
    };
    const mutations = [
        ['invalidImage', seal, mutate(imageId, 31), digest],
        ['invalidJournal', seal, imageId, sha256(journal === '0x' ? '0x01' : mutate(journal, 0))],
        ['invalidSeal', mutate(seal, 4), imageId, digest]
    ];
    if (getBytes(journal).length === 234) {
        mutations.push(['invalidVerdict', seal, imageId, sha256(mutate(journal, 169))]);
    }
    const verificationFailed = id('VerificationFailed()').slice(0, 10);
    for (const [name, ...args] of mutations) {
        await assert.rejects(verifier.verify(...args), error => {
            assert.equal(error.code, 'CALL_EXCEPTION');
            assert.equal(error.data, verificationFailed);
            return true;
        });
        console.log(name, 'reverted', verificationFailed);
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => evm.disconnect());
