// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementBase} from "./SettlementBase.t.sol";

/// S14 (journal digest fixture) and S15 (gas for submit).
contract WireTest is SettlementBase {
    // Fixture from ZKVM-IMPLEMENTATION.md Section 3 and SETTLEMENT-IMPLEMENTATION.md Section 7.
    address internal constant F_ESCROW = 0x1111111111111111111111111111111111111111;
    address internal constant F_PROVIDER = 0x2222222222222222222222222222222222222222;
    bytes32 internal constant F_RULES = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 internal constant F_REF = 0x4444444444444444444444444444444444444444444444444444444444444444;
    bytes32 internal constant F_KEY = 0x5555555555555555555555555555555555555555555555555555555555555555;
    bytes32 internal constant F_ENV_HASH = 0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6;
    bytes32 internal constant F_KC = 0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d;
    bytes32 internal constant F_DIGEST = 0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e;
    bytes internal constant F_ENVELOPE =
        hex"666666666666666666666666f4846535e153e02fbd1c8c3a8fff73b6b3ad081d0b4838c0baa5dea92b84d556";

    function _fixtureContext() internal pure returns (bytes memory) {
        return _context(5042002, F_ESCROW, 7, F_PROVIDER, F_RULES, F_REF);
    }

    // ------------------------------------------------------------------ S14

    function test_S14_contextAndJournalLengths() public pure {
        bytes memory ctx = _fixtureContext();
        assertEq(ctx.length, 169, "context length");
        assertEq(_journal(ctx, 1, F_ENV_HASH, F_KC).length, 234, "journal length");
        assertEq(uint8(ctx[0]), 1, "version byte");
    }

    function test_S14_contextLayoutBytes() public pure {
        bytes memory ctx = _fixtureContext();
        // chainId big-endian in bytes 1..32 : 5042002 = 0x4cef52
        assertEq(uint8(ctx[30]), 0x4c);
        assertEq(uint8(ctx[31]), 0xef);
        assertEq(uint8(ctx[32]), 0x52);
        assertEq(uint8(ctx[33]), 0x11, "escrow starts at 33");
        assertEq(uint8(ctx[52]), 0x11, "escrow ends at 52");
        assertEq(uint8(ctx[84]), 7, "job id low byte at 84");
        assertEq(uint8(ctx[85]), 0x22, "provider starts at 85");
        assertEq(uint8(ctx[104]), 0x22);
        assertEq(uint8(ctx[105]), 0x33, "rules starts at 105");
        assertEq(uint8(ctx[137]), 0x44, "reference starts at 137");
        assertEq(uint8(ctx[168]), 0x44);
    }

    function test_S14_journalDigestFixture() public pure {
        bytes memory journal = _journal(_fixtureContext(), 1, F_ENV_HASH, F_KC);
        assertEq(sha256(journal), F_DIGEST, "journal digest");
    }

    function test_S14_keyCommitmentFixture() public pure {
        assertEq(_keyCommitment(_fixtureContext(), F_KEY), F_KC, "key commitment");
    }

    function test_S14_envelopeHashFixture() public pure {
        assertEq(F_ENVELOPE.length, 44);
        assertEq(sha256(F_ENVELOPE), F_ENV_HASH, "envelope hash");
    }

    function test_S14_verdictZeroChangesDigest() public pure {
        bytes memory journal0 = _journal(_fixtureContext(), 0, F_ENV_HASH, F_KC);
        assertTrue(sha256(journal0) != F_DIGEST);
    }

    /// Registering only THIS file's digest on the mock must be enough for a valid submit, which
    /// proves the hook builds the exact same journal for a live job.
    function test_S14_hookJournalMatchesEncoderOnLiveJob() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(300);
        bytes memory ctx = _liveContext(s, id, solver);
        assertEq(ctx.length, 169);
        bytes32 kc = _keyCommitment(ctx, KEY);
        bytes memory journal = _journal(ctx, 1, sha256(env), kc);
        assertEq(journal.length, 234);
        bytes memory seal = _seal(42);
        s.verifier.expect(seal, IMAGE_ID, sha256(journal)); // the only triple on the mock
        _submit(s, id, env, seal, kc);
        assertEq(_status(s, id), SUBMITTED);
        // and the key commitment the hook later checks is the same construction
        _release(s, id, KEY);
        assertEq(_status(s, id), COMPLETED);
    }

    // ------------------------------------------------------------------ S15

    function _gasSubmit(uint256 len) internal returns (uint256 used) {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(len);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        bytes32 h = sha256(env);
        bytes memory opt = abi.encode(env, seal, kc);
        vm.prank(solver);
        uint256 g0 = gasleft();
        s.core.submit(id, h, opt);
        used = g0 - gasleft();
        assertEq(_status(s, id), SUBMITTED);
    }

    function test_S15_gasTypicalEnvelope1KiB() public {
        uint256 used = _gasSubmit(1024);
        emit log_named_uint("S15 submit gas, 1 KiB envelope, mock verifier", used);
        assertTrue(used < 30_000_000, "over block gas limit");
    }

    function test_S15_gasEnvelope256B() public {
        emit log_named_uint("S15 submit gas, 256 B envelope, mock verifier", _gasSubmit(256));
    }

    function test_S15_gasMaxEnvelope() public {
        uint256 used = _gasSubmit(MAX_ENVELOPE);
        emit log_named_uint("S15 submit gas, 16412 B envelope, mock verifier", used);
        assertTrue(used < 30_000_000, "over block gas limit");
    }

    function test_S15_gasEnvelope8KiB() public {
        emit log_named_uint("S15 submit gas, 8192 B envelope, mock verifier", _gasSubmit(8192));
    }

    function test_S15_envelopeOverCapReverts() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(MAX_ENVELOPE + 1);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        _submitExpectRevert(s, id, env, seal, kc);
        _assertFundedNotSubmitted(s, id);
    }

    function test_S15_envelopeAtCapAccepted() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(MAX_ENVELOPE);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        _submit(s, id, env, seal, kc);
        assertEq(_status(s, id), SUBMITTED);
    }
}
