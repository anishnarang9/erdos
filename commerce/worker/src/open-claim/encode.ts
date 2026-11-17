import { encodeFunctionData, type Hex } from "viem";
import { openClaimClaimReleaseAbi } from "./fixture.ts";

const abi = openClaimClaimReleaseAbi;

export function encodeOpenClaimClaim(args: { jobId: bigint; envelope: Hex; seal: Hex; keyCommitment: Hex }): Hex {
  return encodeFunctionData({ abi, functionName: "claim", args: [args.jobId, args.envelope, args.seal, args.keyCommitment] });
}

export function encodeOpenClaimRelease(args: { jobId: bigint; key: Hex }): Hex {
  return encodeFunctionData({ abi, functionName: "release", args: [args.jobId, args.key] });
}
