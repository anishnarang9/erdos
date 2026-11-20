import { fallback, http, type Transport } from "viem";

const ARC_PUBLIC_RPC = "https://rpc.testnet.arc.io/";
const ARC_SECONDARY_RPC = "https://rpc.quicknode.testnet.arc.io/";
const PUBLIC_READ_METHODS = [
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
] as const;

/** Public reads can retry. Journaled sends keep their dedicated single-endpoint transport. */
export function arcPublicReadTransport(rpcUrl: string): Transport {
  const endpoint = new URL(rpcUrl);
  const methods = { include: [...PUBLIC_READ_METHODS] };
  if (endpoint.href !== ARC_PUBLIC_RPC) {
    return http(endpoint.href, { methods, retryCount: 2, retryDelay: 1000 });
  }
  const transports = [ARC_PUBLIC_RPC, ARC_SECONDARY_RPC].map(url =>
    http(url, { methods, retryCount: 0, timeout: 8000 }),
  );
  return fallback(transports, { retryCount: 2, retryDelay: 1000 });
}
