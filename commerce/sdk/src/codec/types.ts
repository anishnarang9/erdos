import type { Address, Hex } from "viem";

export interface FundedContext {
  chainId: bigint;
  escrow: Address;
  jobId: bigint;
  provider: Address;
  /** 32 bytes */
  rulesHash: Hex;
  /** 32 bytes */
  referenceHash: Hex;
}

export interface BundleFile {
  name: string;
  content: Uint8Array;
}

export interface Journal {
  context: FundedContext;
  verdict: 0 | 1;
  envelopeHash: Hex;
  keyCommitment: Hex;
}

export interface ProofPackage {
  version: 1;
  context: FundedContext;
  contextBytes: Uint8Array;
  imageId: Hex;
  verdict: 0 | 1;
  envelope: Uint8Array;
  envelopeHash: Hex;
  keyCommitment: Hex;
  journal: Uint8Array;
  journalDigest: Hex;
  seal: Hex;
}
