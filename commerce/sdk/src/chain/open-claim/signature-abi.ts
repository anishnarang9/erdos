import type { Abi } from "viem";

/**
 * Function signatures from docs/overnight/open-claim-v1.md at codex/overnight-open-escrow 43b4fca.
 * That commit does not contain contracts/abi/OpenClaimAdapter.json.
 * Events and custom errors are unpublished, so they are absent here on purpose.
 */
export const OPEN_CLAIM_INTERFACE_REVISION = "43b4fca";
export const OPEN_CLAIM_ABI_STATUS = "signature-fixture" as const;
export const OPEN_CLAIM_MAX_ENVELOPE_BYTES = 16_412;
export const OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC = 600;
/** 1 USDC in the published Arc token's 6 decimal base units. */
export const OPEN_CLAIM_ONE_USDC = 1_000_000n;

const termsComponents = [
  { name: "buyer", type: "address" },
  { name: "imageId", type: "bytes32" },
  { name: "rulesHash", type: "bytes32" },
  { name: "referenceHash", type: "bytes32" },
  { name: "budget", type: "uint256" },
  { name: "expiry", type: "uint64" },
  { name: "registered", type: "bool" },
] as const;

const submissionComponents = [
  { name: "solver", type: "address" },
  { name: "envelopeHash", type: "bytes32" },
  { name: "keyCommitment", type: "bytes32" },
  { name: "accepted", type: "bool" },
] as const;

export const openClaimSignatureAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "imageId", type: "bytes32" },
      { name: "rulesHash", type: "bytes32" },
      { name: "referenceHash", type: "bytes32" },
      { name: "expectedBudget", type: "uint256" },
      { name: "expectedExpiry", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "envelope", type: "bytes" },
      { name: "seal", type: "bytes" },
      { name: "keyCommitment", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "key", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "contextOf",
    stateMutability: "view",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "solver", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "expectedJournal",
    stateMutability: "view",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "solver", type: "address" },
      { name: "envelopeHash", type: "bytes32" },
      { name: "keyCommitment", type: "bytes32" },
    ],
    outputs: [
      { name: "journal", type: "bytes" },
      { name: "journalDigest", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "core",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "verifier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "terms",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: termsComponents }],
  },
  {
    type: "function",
    name: "submissions",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: submissionComponents }],
  },
  {
    type: "function",
    name: "released",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "MAX_ENVELOPE_BYTES",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MIN_EXPIRY_MARGIN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;
