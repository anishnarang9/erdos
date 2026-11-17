// The compiled adapter ABI is exported through the SDK. The published wire vector
// remains an independent check of context, journal, and commitment bytes.
import { bytesToHex, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import {
  encodeContext, encodeJournal, journalDigest, keyCommitment,
  OPEN_CLAIM_ABI_STATUS as SDK_ABI_STATUS,
  OPEN_CLAIM_INTERFACE_REVISION as SDK_INTERFACE_REVISION,
  openClaimSignatureAbi as exportedAdapterAbi,
} from "@ubc26/sdk";

export const OPEN_CLAIM_INTERFACE_REVISION = SDK_INTERFACE_REVISION;
export const OPEN_CLAIM_ABI_STATUS = SDK_ABI_STATUS;
export const OPEN_CLAIM_JSON_ABI_PUBLISHED = true;
export const OPEN_CLAIM_MAX_ENVELOPE_BYTES = 16_412;
export const OPEN_CLAIM_ONE_USDC = 1_000_000n;

const PUBLISHED_SELECTORS = {
  register: "0x22c1d372",
  claim: "0xdbadcda7",
  release: "0xdd20edf9",
  contextOf: "0xd19aca07",
  expectedJournal: "0x981fa9ee",
  terms: "0xc0aa0e8a",
  submissions: "0xad73349e",
  released: "0xa94d373b",
} as const;

const SIGNATURES = {
  register: "register(uint256,bytes32,bytes32,bytes32,uint256,uint64)",
  claim: "claim(uint256,bytes,bytes,bytes32)",
  release: "release(uint256,bytes32)",
  contextOf: "contextOf(uint256,address)",
  expectedJournal: "expectedJournal(uint256,address,bytes32,bytes32)",
  terms: "terms(uint256)",
  submissions: "submissions(uint256)",
  released: "released(uint256)",
} as const;

function pin(name: keyof typeof SIGNATURES): Hex {
  const computed = toFunctionSelector(SIGNATURES[name]);
  const exported = exportedAdapterAbi.find(item => item.type === "function" && item.name === name);
  if (computed !== PUBLISHED_SELECTORS[name]) {
    throw new Error(`open-claim selector drift for ${name}: computed ${computed}, published ${PUBLISHED_SELECTORS[name]}`);
  }
  if (!exported || exported.type !== "function" || toFunctionSelector(exported) !== computed) {
    throw new Error(`compiled open-claim ABI differs from the published ${name} selector`);
  }
  return computed;
}

export const OPEN_CLAIM_SELECTORS = {
  register: pin("register"),
  claim: pin("claim"),
  release: pin("release"),
  contextOf: pin("contextOf"),
  expectedJournal: pin("expectedJournal"),
  terms: pin("terms"),
  submissions: pin("submissions"),
  released: pin("released"),
} as const;

export const OPEN_CLAIM_CLAIM_SELECTOR = OPEN_CLAIM_SELECTORS.claim;
export const OPEN_CLAIM_RELEASE_SELECTOR = OPEN_CLAIM_SELECTORS.release;

export const OPEN_CLAIM_EVENTS = ["TermsRegistered", "ClaimAccepted", "KeyReleased"] as const;

export const openClaimSignatureAbi = exportedAdapterAbi;
const claimReleaseTypes = parseAbi([
  "function claim(uint256 jobId, bytes envelope, bytes seal, bytes32 keyCommitment)",
  "function release(uint256 jobId, bytes32 key)",
]);
/** Runtime calls use the compiled JSON ABI. The local type narrows decoded calls. */
export const openClaimClaimReleaseAbi = exportedAdapterAbi as typeof claimReleaseTypes;

const repeat = (byte: string, size: number) => `0x${byte.repeat(size)}`;
const adapter = "0x1111111111111111111111111111111111111111" as Address;
const solver = "0x2222222222222222222222222222222222222222" as Address;
const rulesHash = repeat("33", 32) as Hex;
const referenceHash = repeat("44", 32) as Hex;
const envelopeHash = "0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6" as Hex;
const publishedContext = "0x0100000000000000000000000000000000000000000000000000000000004cef5211111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000007222222222222222222222222222222222222222233333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444" as Hex;
const publishedCommitment = "0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d" as Hex;
const publishedDigest = "0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e" as Hex;
const key = new Uint8Array(32).fill(0x55);
const contextBody = { chainId: 5042002n, escrow: adapter, jobId: 7n, provider: solver, rulesHash, referenceHash };
const contextBytes = encodeContext(contextBody);
const context = bytesToHex(contextBytes) as Hex;
const commitment = keyCommitment(contextBytes, key);
const journalBytes = encodeJournal({ context: contextBody, verdict: 1, envelopeHash, keyCommitment: commitment });
const journal = bytesToHex(journalBytes) as Hex;
const digest = journalDigest(journalBytes);
if (context !== publishedContext || commitment !== publishedCommitment || digest !== publishedDigest) {
  throw new Error("open-claim synthetic vector does not match the published wire fixture");
}

/** Published synthetic vector. Escrow is the adapter and provider is the solver. */
export const OPEN_CLAIM_SYNTHETIC = {
  chainId: 5042002,
  adapter,
  solver,
  jobId: 7n,
  rulesHash,
  referenceHash,
  key: repeat("55", 32) as Hex,
  envelopeHash,
  keyCommitment: publishedCommitment,
  context: publishedContext,
  journal,
  journalDigest: publishedDigest,
} as const;
