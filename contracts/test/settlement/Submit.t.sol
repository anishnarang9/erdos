// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementBase} from "./SettlementBase.t.sol";
import {AgenticCommerce as Core} from "../../src/core/src/AgenticCommercePatched.sol";
import {MockRiscZeroVerifier} from "../../src/verifier/MockRiscZeroVerifier.sol";

/// S5 to S8: bad submissions, verdict 0, replay and substitution, retry.
contract SubmitTest is SettlementBase {
    // ------------------------------------------------------------------ S5

    function test_S5_wrongImageIdReverts() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        bytes memory ctx = _liveContext(s, id, solver);
        bytes32 kc = _keyCommitment(ctx, KEY);
        bytes memory seal = _seal(1);
        // A genuine proof of the right journal, but for a different program.
        s.verifier.expect(seal, IMAGE_ID_B, sha256(_journal(ctx, 1, sha256(env), kc)));
        _submitExpectRevert(s, id, env, seal, kc);
        _assertFundedNotSubmitted(s, id);
    }

    function test_S5_mutatedEnvelopeReverts() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);

        // (a) deliverable hash recomputed for the mutated envelope: the proof no longer matches
        bytes memory bad = _envelope(512);
        bad[100] = bytes1(uint8(bad[100]) ^ 0x01);
        _submitExpectRevert(s, id, bad, seal, kc);

        // (b) mutated envelope under the original deliverable hash: sha256(envelope) != deliverable
        bytes32 origHash = sha256(env);
        bytes memory opt = abi.encode(bad, seal, kc);
        _submitRawExpectRevert(s, id, solver, origHash, opt);

        // (c) original envelope under a wrong deliverable hash
        bytes memory optGood = abi.encode(env, seal, kc);
        _submitRawExpectRevert(s, id, solver, sha256(bad), optGood);

        _assertFundedNotSubmitted(s, id);
    }

    function test_S5_invalidSealReverts() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);

        bytes memory flipped = seal;
        flipped[200] = bytes1(uint8(flipped[200]) ^ 0x01);
        _submitExpectRevert(s, id, env, flipped, kc);

        bytes memory truncated = new bytes(seal.length - 1);
        for (uint256 i; i < truncated.length; i++) {
            truncated[i] = seal[i];
        }
        _submitExpectRevert(s, id, env, truncated, kc);

        _submitExpectRevert(s, id, env, "", kc);
        _submitExpectRevert(s, id, env, _seal(999), kc);

        _assertFundedNotSubmitted(s, id);
    }

    function test_S5_overMaxEnvelopeReverts() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(MAX_ENVELOPE + 1);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        _submitExpectRevert(s, id, env, seal, kc);
        _assertFundedNotSubmitted(s, id);
    }

    // ------------------------------------------------------------------ S6

    function test_S6_verdictZeroReceiptVerifiesButSubmitReverts() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        bytes memory ctx = _liveContext(s, id, solver);
        bytes32 kc = _keyCommitment(ctx, KEY);
        bytes memory seal0 = _seal(0xdead);
        bytes32 digest0 = sha256(_journal(ctx, 0, sha256(env), kc));
        s.verifier.expect(seal0, IMAGE_ID, digest0);

        // The verifier itself accepts the genuine verdict-0 receipt.
        s.verifier.verify(seal0, IMAGE_ID, digest0);

        // The hook rebuilds the journal with verdict 1, so the same seal cannot satisfy submit.
        _submitExpectRevert(s, id, env, seal0, kc);
        _assertFundedNotSubmitted(s, id);

        // Control: the verdict-1 proof for the same data is accepted.
        bytes32 digest1 = sha256(_journal(ctx, 1, sha256(env), kc));
        s.verifier.expect(seal0, IMAGE_ID, digest1);
        _submit(s, id, env, seal0, kc);
        assertEq(_status(s, id), SUBMITTED);
    }

    // ------------------------------------------------------------------ S7

    function test_S7_commitmentSubstitution() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kcA) = _proof(s, id, env, KEY);
        bytes32 kcB = _keyCommitment(_liveContext(s, id, solver), KEY_B);

        // Proof is for commitment A; the Solver passes B.
        _submitExpectRevert(s, id, env, seal, kcB);
        _assertFundedNotSubmitted(s, id);

        // A succeeds, then only key A releases; key B does not.
        _submit(s, id, env, seal, kcA);
        _releaseExpectRevert(s, id, solver, KEY_B);
        _release(s, id, KEY);
        assertEq(_status(s, id), COMPLETED);
    }

    function test_S7_replayAcrossJobs() public {
        uint256 id1 = _fundedJob();
        uint256 id2 = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id1, env, KEY);

        _submitExpectRevert(s, id2, env, seal, kc);
        _assertFundedNotSubmitted(s, id2);

        _submit(s, id1, env, seal, kc);
        // Even after job 1 accepted it, job 2 cannot reuse the proof.
        _submitExpectRevert(s, id2, env, seal, kc);
        _assertFundedNotSubmitted(s, id2);
    }

    function test_S7_replayAcrossProviders() public {
        // Job funded for solver2. A proof built for the same job id but provider = solver must fail.
        uint256 id = _createAndFund(s, solver2, BUDGET, EXPIRY);
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proofFor(s, id, solver, env, KEY);
        bytes32 h = sha256(env);
        bytes memory opt = abi.encode(env, seal, kc);
        _submitRawExpectRevert(s, id, solver2, h, opt);
        _submitRawExpectRevert(s, id, solver, h, opt); // solver is not the provider
        _assertFundedNotSubmitted(s, id);

        // Control: the proof bound to solver2 is accepted.
        (bytes memory seal2, bytes32 kc2) = _proofFor(s, id, solver2, env, KEY);
        bytes memory opt2 = abi.encode(env, seal2, kc2);
        vm.prank(solver2);
        s.core.submit(id, h, opt2);
        assertEq(_status(s, id), SUBMITTED);
    }

    function test_S7_replayAcrossEscrow() public {
        // Second core+hook stack with the same token and the same verifier. Job ids coincide (1).
        Stack memory k2 = _deployStack(s.token, address(s.verifier));
        uint256 id1 = _fundedJob();
        uint256 id2 = _createAndFund(k2, solver, BUDGET, EXPIRY);
        assertEq(id1, id2, "job ids must coincide for an isolated escrow test");
        assertTrue(address(k2.core) != address(s.core));

        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id1, env, KEY);

        _submitExpectRevert(k2, id2, env, seal, kc);
        _assertFundedNotSubmitted(k2, id2);

        // Control: valid on the escrow it was built for.
        _submit(s, id1, env, seal, kc);
        assertEq(_status(s, id1), SUBMITTED);
        // And still refused on the other escrow afterwards.
        _submitExpectRevert(k2, id2, env, seal, kc);
    }

    function test_S7_replayAcrossChains() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY); // bound to chain 5042002

        vm.chainId(ARC_CHAIN_ID + 1);
        _submitExpectRevert(s, id, env, seal, kc);
        vm.chainId(1);
        _submitExpectRevert(s, id, env, seal, kc);
        assertEq(_status(s, id), FUNDED);

        vm.chainId(ARC_CHAIN_ID);
        _submit(s, id, env, seal, kc);
        assertEq(_status(s, id), SUBMITTED);
    }

    function test_S7_everyJournalFieldIsBound() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        bytes32 envHash = sha256(env);
        address core = address(s.core);

        bytes[] memory ctxs = new bytes[](6);
        ctxs[0] = _context(block.chainid + 1, core, id, solver, RULES_HASH, REFERENCE_HASH);
        ctxs[1] = _context(block.chainid, other, id, solver, RULES_HASH, REFERENCE_HASH);
        ctxs[2] = _context(block.chainid, core, id + 1, solver, RULES_HASH, REFERENCE_HASH);
        ctxs[3] = _context(block.chainid, core, id, other, RULES_HASH, REFERENCE_HASH);
        ctxs[4] = _context(block.chainid, core, id, solver, bytes32(uint256(RULES_HASH) + 1), REFERENCE_HASH);
        ctxs[5] = _context(block.chainid, core, id, solver, RULES_HASH, bytes32(uint256(REFERENCE_HASH) + 1));

        for (uint256 i; i < ctxs.length; i++) {
            // Fully self-consistent proof for a neighbouring context (commitment recomputed from it).
            bytes32 kc = _keyCommitment(ctxs[i], KEY);
            bytes memory seal = _seal(100 + i);
            s.verifier.expect(seal, IMAGE_ID, sha256(_journal(ctxs[i], 1, envHash, kc)));
            _submitExpectRevert(s, id, env, seal, kc);
        }
        // Different envelope hash inside the journal.
        {
            bytes memory ctx = _liveContext(s, id, solver);
            bytes32 kc = _keyCommitment(ctx, KEY);
            bytes memory seal = _seal(200);
            s.verifier.expect(seal, IMAGE_ID, sha256(_journal(ctx, 1, bytes32(uint256(envHash) + 1), kc)));
            _submitExpectRevert(s, id, env, seal, kc);
        }
        _assertFundedNotSubmitted(s, id);
    }

    function test_S7_resubmitAfterAcceptedReverts() public {
        (uint256 id, bytes memory env, bytes32 kc) = _submittedJob();
        (bytes memory seal,) = _proof(s, id, env, KEY);
        _submitExpectRevert(s, id, env, seal, kc);
        (bytes32 h, bytes32 storedKc, bool acc) = s.hook.submissions(id);
        assertEq(h, sha256(env));
        assertEq(storedKc, kc);
        assertTrue(acc);
    }

    // ------------------------------------------------------------------ S8

    function test_S8_retryAfterFailedSubmissionSucceeds() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);

        // attempt 1: unregistered seal
        _submitExpectRevert(s, id, env, _seal(7777), kc);
        _assertFundedNotSubmitted(s, id);
        // attempt 2: wrong commitment
        _submitExpectRevert(s, id, env, seal, bytes32(uint256(kc) ^ 1));
        _assertFundedNotSubmitted(s, id);
        // attempt 3: mutated envelope
        bytes memory bad = _envelope(512);
        bad[0] = bytes1(uint8(bad[0]) ^ 0xff);
        _submitExpectRevert(s, id, bad, seal, kc);
        _assertFundedNotSubmitted(s, id);

        // retry with the right data before expiry
        bytes32 h = sha256(env);
        vm.expectEmit(true, true, false, true, address(s.core));
        emit JobSubmitted(id, solver, h);
        vm.expectEmit(true, false, false, true, address(s.hook));
        emit ProofAccepted(id, h, kc);
        _submit(s, id, env, seal, kc);

        assertEq(_status(s, id), SUBMITTED);
        (bytes32 eh, bytes32 skc, bool acc) = s.hook.submissions(id);
        assertEq(eh, h);
        assertEq(skc, kc);
        assertTrue(acc);
        assertEq(_bal(s, address(s.core)), BUDGET, "escrow still locked");
    }

    function test_S8_retryAfterTimePassesButBeforeExpiry() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        _submitExpectRevert(s, id, env, _seal(1), kc);
        vm.warp(EXPIRY - 1);
        _submit(s, id, env, seal, kc);
        assertEq(_status(s, id), SUBMITTED);
    }
}
