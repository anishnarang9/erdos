import type { Abi, Address, Hex, PublicClient } from "viem";
import { arcCoreAbi } from "../arc/abi.ts";
import { OpenClaimError } from "./errors.ts";
import { deploymentOf } from "./guards.ts";
import { openClaimSignatureAbi } from "./signature-abi.ts";
import type { OpenClaimChainPort, OpenClaimChainSnapshot, OpenClaimDeployment, OpenClaimObservation } from "./types.ts";

type CoreJob = NonNullable<OpenClaimChainSnapshot["job"]>;
type Terms = NonNullable<OpenClaimChainSnapshot["terms"]>;
type Submission = NonNullable<OpenClaimChainSnapshot["submission"]>;

/** Read a single contract result at a fixed block, using the checked-in compiled ABI. */
async function read<T>(
  client: PublicClient, address: Address, abi: Abi, functionName: string, blockNumber: bigint,
  args: readonly unknown[] = [],
): Promise<T> {
  const request = { address, abi, functionName, args, blockNumber } as Parameters<PublicClient["readContract"]>[0];
  return await client.readContract(request) as T;
}

function pinnedBlock(head: bigint, confirmations: bigint): bigint {
  if (head < confirmations) throw new OpenClaimError("awaiting_receipt", "chain has too few blocks for confirmation margin");
  return head - confirmations;
}

/** Build a read-only Arc port. It never signs, sends, or retries a transaction. */
export function createViemOpenClaimPort(
  client: PublicClient,
  options: { confirmations?: bigint } = {},
): OpenClaimChainPort {
  const confirmations = options.confirmations ?? 0n;
  if (confirmations < 0n) throw new OpenClaimError("unsupported_terms", "confirmations cannot be negative");

  async function atBlock(): Promise<bigint> {
    return pinnedBlock(await client.getBlockNumber({ cacheTime: 0 }), confirmations);
  }

  return {
    async observe(input: OpenClaimDeployment): Promise<OpenClaimObservation> {
      const deployment = deploymentOf(input);
      const chainId = await client.getChainId();
      const blockNumber = await atBlock();
      const code = await client.getBytecode({ address: deployment.adapter, blockNumber });
      const token = await read<Address>(client, deployment.core, arcCoreAbi, "paymentToken", blockNumber);
      const evaluatorFeeBP = await read<bigint>(client, deployment.core, arcCoreAbi, "evaluatorFeeBP", blockNumber);
      const platformFeeBP = await read<bigint>(client, deployment.core, arcCoreAbi, "platformFeeBP", blockNumber);
      const adapterCore = await read<Address>(client, deployment.adapter, openClaimSignatureAbi, "core", blockNumber);
      const adapterVerifier = await read<Address>(client, deployment.adapter, openClaimSignatureAbi, "verifier", blockNumber);
      const adapterUsdc = await read<Address>(client, deployment.adapter, openClaimSignatureAbi, "usdc", blockNumber);
      const maxEnvelopeBytes = await read<bigint>(client, deployment.adapter, openClaimSignatureAbi, "MAX_ENVELOPE_BYTES", blockNumber);
      const minExpiryMargin = await read<bigint>(client, deployment.adapter, openClaimSignatureAbi, "MIN_EXPIRY_MARGIN", blockNumber);
      return { chainId, token, evaluatorFeeBP, platformFeeBP,
        adapterCode: code && code !== "0x" ? "present" : "absent",
        adapterCore, adapterVerifier, adapterUsdc, maxEnvelopeBytes, minExpiryMargin };
    },

    async snapshot(input: OpenClaimDeployment, jobId: bigint): Promise<OpenClaimChainSnapshot> {
      const deployment = deploymentOf(input);
      if (await client.getChainId() !== deployment.chainId) {
        throw new OpenClaimError("wrong_deployment", "chain id differs from the open-claim deployment");
      }
      const blockNumber = await atBlock();
      const job = await read<CoreJob>(client, deployment.core, arcCoreAbi, "getJob", blockNumber, [jobId]);
      const rawTerms = await read<readonly [Address, Hex, Hex, Hex, bigint, bigint, boolean]>(
        client, deployment.adapter, openClaimSignatureAbi, "terms", blockNumber, [jobId],
      );
      const rawSubmission = await read<readonly [Address, Hex, Hex, boolean]>(
        client, deployment.adapter, openClaimSignatureAbi, "submissions", blockNumber, [jobId],
      );
      const released = await read<boolean>(client, deployment.adapter, openClaimSignatureAbi, "released", blockNumber, [jobId]);
      const token = await read<Address>(client, deployment.core, arcCoreAbi, "paymentToken", blockNumber);
      const evaluatorFeeBP = await read<bigint>(client, deployment.core, arcCoreAbi, "evaluatorFeeBP", blockNumber);
      const platformFeeBP = await read<bigint>(client, deployment.core, arcCoreAbi, "platformFeeBP", blockNumber);
      const core = await read<Address>(client, deployment.adapter, openClaimSignatureAbi, "core", blockNumber);
      const verifier = await read<Address>(client, deployment.adapter, openClaimSignatureAbi, "verifier", blockNumber);
      const usdc = await read<Address>(client, deployment.adapter, openClaimSignatureAbi, "usdc", blockNumber);
      const terms: Terms | null = rawTerms[6] ? {
        buyer: rawTerms[0], imageId: rawTerms[1], rulesHash: rawTerms[2], referenceHash: rawTerms[3],
        budget: rawTerms[4], expiry: rawTerms[5], registered: rawTerms[6],
      } : null;
      const submission: Submission | null = rawSubmission[3] ? {
        solver: rawSubmission[0], envelopeHash: rawSubmission[1], keyCommitment: rawSubmission[2],
        accepted: rawSubmission[3],
      } : null;
      return { blockNumber, job: job.id === 0n ? null : job, terms, submission, released,
        token, evaluatorFeeBP, platformFeeBP, wiring: { core, verifier, usdc } };
    },
  };
}
