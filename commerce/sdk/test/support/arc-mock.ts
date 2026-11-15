// Mock JSON-RPC for the arc unit tests: a viem `custom` transport backed by handlers that answer
// with data encoded from the real ABIs. No network, no chain.
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  numberToHex,
} from "viem";
import type { Abi, AbiEvent, Address, Hex, PublicClient } from "viem";
import { arc } from "../../src/index.ts";

export const D = arc.ARC_TESTNET;

export interface RpcCall {
  method: string;
  params: readonly unknown[];
}

export type RpcHandler = (method: string, params: readonly unknown[]) => unknown;

/** A JSON-RPC error as a node returns it for a revert: code 3 and the revert data. */
export function revertError(data?: Hex, message = "execution reverted"): Error {
  return Object.assign(new Error(message), { code: 3, ...(data !== undefined ? { data } : {}) });
}

/** Revert data for a custom error of the core, the hook or the verifier. */
export function customError(errorName: string, args: readonly unknown[] = []): Hex {
  return encodeErrorResult({ abi: arc.errorsAbi, errorName, args });
}

export function mockRpc(handler: RpcHandler): { pc: PublicClient; calls: RpcCall[]; transport: ReturnType<typeof custom> } {
  const calls: RpcCall[] = [];
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        const p = (Array.isArray(params) ? params : []) as readonly unknown[];
        calls.push({ method, params: p });
        return handler(method, p);
      },
    },
    { retryCount: 0 },
  );
  const pc = createPublicClient({ transport, pollingInterval: 1 });
  return { pc, calls, transport };
}

export interface EthCall {
  from?: Address;
  to: Address;
  data: Hex;
  gas?: Hex;
}

export const ethCallOf = (params: readonly unknown[]): EthCall => params[0] as EthCall;

/** Implementation of one contract function: returns the value(s) to ABI-encode, or throws `revertError(...)`. */
export type FnImpl = (args: readonly unknown[], call: EthCall) => unknown;

export interface MockContract {
  address: Address;
  abi: Abi;
  fns: Record<string, FnImpl>;
}

/** Answers eth_call by decoding the calldata with the contract's ABI and encoding the implementation's result. */
export function ethCallRouter(contracts: readonly MockContract[]): (call: EthCall) => Hex {
  return (call) => {
    const c = contracts.find((x) => x.address.toLowerCase() === call.to.toLowerCase());
    if (!c) throw new Error(`mock: no contract at ${call.to}`);
    const { functionName, args } = decodeFunctionData({ abi: c.abi, data: call.data });
    const impl = c.fns[functionName];
    if (!impl) throw new Error(`mock: ${functionName} is not implemented`);
    return encodeFunctionResult({ abi: c.abi, functionName, result: impl(args ?? [], call) });
  };
}

export interface ChainState {
  chainId: number;
  blockNumber: bigint;
  timestamp: bigint;
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export const defaultState = (): ChainState => ({
  chainId: D.chainId,
  blockNumber: 72_450_000n,
  timestamp: 1_794_000_000n,
  baseFeePerGas: 20_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
});

/** Handles the chain-level methods; `extra` sees every call first and returns undefined to fall through. */
export function chainHandler(state: ChainState, extra: (method: string, params: readonly unknown[]) => unknown): RpcHandler {
  return (method, params) => {
    const handled = extra(method, params);
    if (handled !== undefined) return handled;
    switch (method) {
      case "eth_chainId":
        return numberToHex(state.chainId);
      case "eth_blockNumber":
        return numberToHex(state.blockNumber);
      case "eth_getBlockByNumber":
        return {
          number: numberToHex(state.blockNumber),
          hash: `0x${"b1".repeat(32)}`,
          parentHash: `0x${"b0".repeat(32)}`,
          timestamp: numberToHex(state.timestamp),
          baseFeePerGas: numberToHex(state.baseFeePerGas),
          gasLimit: numberToHex(30_000_000),
          gasUsed: "0x0",
          transactions: [],
        };
      case "eth_maxPriorityFeePerGas":
        return numberToHex(state.maxPriorityFeePerGas);
      case "eth_gasPrice":
        return numberToHex(state.baseFeePerGas + state.maxPriorityFeePerGas);
      default:
        throw new Error(`mock: unexpected ${method}`);
    }
  };
}

/** A raw JSON-RPC log for an event of `abi`, with the arguments given by name. */
export function rpcLog(
  address: Address,
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  at: { blockNumber?: bigint; logIndex?: number; transactionHash?: Hex } = {},
): { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex; blockHash: Hex; transactionIndex: Hex; removed: boolean } {
  const event = abi.find((x): x is AbiEvent => x.type === "event" && x.name === eventName);
  if (!event) throw new Error(`mock: no event ${eventName}`);
  const topics = encodeEventTopics({ abi, eventName, args }) as Hex[];
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    plain,
    plain.map((i) => args[i.name ?? ""]),
  );
  return {
    address,
    topics,
    data,
    blockNumber: numberToHex(at.blockNumber ?? 72_400_000n),
    logIndex: numberToHex(at.logIndex ?? 0),
    transactionHash: at.transactionHash ?? (`0x${"ee".repeat(32)}` as Hex),
    blockHash: `0x${"b1".repeat(32)}`,
    transactionIndex: "0x0",
    removed: false,
  };
}
