// Arc testnet access from the browser: public reads through the same-origin /rpc proxy, and the buyer's
// wallet (an injected EIP-1193 wallet such as MetaMask) for the four Poster transactions.
import { createPublicClient, createWalletClient, custom, decodeAbiParameters, decodeFunctionData, http, type Hex, type PublicClient, type WalletClient } from "viem";
import { arc, decodeBundle, decryptEnvelope, envelopeHash, keyCommitment, type BundleFile } from "@ubc26/sdk";

export const deployment = arc.ARC_TESTNET;
export const publicClient = createPublicClient({ transport: http(`${location.origin}/rpc`) }) as PublicClient;
export const explorerTx = (hash: string) => `https://explorer.testnet.arc.io/tx/${hash}`;

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function injected(): Eip1193 | null {
  return ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) as Eip1193 | null;
}

export const hasInjectedWallet = () => injected() !== null;

/** Connects the injected wallet and switches it to Arc testnet (adding the network if it is missing). */
export async function connectWallet(): Promise<WalletClient> {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or another EIP-1193 wallet) and reload.");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Hex[];
  if (!address) throw new Error("The wallet returned no account");
  const chainIdHex = `0x${deployment.chainId.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: "Arc Testnet",
          // Arc pays gas in USDC; the native balance has 18 decimals.
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [deployment.rpcUrl],
          blockExplorerUrls: ["https://explorer.testnet.arc.io"],
        },
      ],
    });
  }
  return createWalletClient({ account: address, transport: custom(eth) });
}

export interface Delivery {
  files: BundleFile[];
  envelopeHashOk: boolean;
  keyOk: boolean;
  /** Kept so a recording can re-verify and re-decrypt offline. */
  envelope: Uint8Array;
  context: Uint8Array;
}

/**
 * The buyer's delivery from public chain data only: the envelope from the accepted submit calldata, the released
 * key, and the context the hook built. Both commitments are checked before anything is decrypted.
 */
export async function fetchDelivery(chainJobId: bigint, submitTx: Hex, key: Hex, expected: { envelopeHash: string; keyCommitment: string }): Promise<Delivery> {
  const tx = await publicClient.getTransaction({ hash: submitTx });
  const call = decodeFunctionData({ abi: arc.coreAbi, data: tx.input });
  if (call.functionName !== "submit") throw new Error("The submit transaction is not core.submit");
  const [envHex] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], (call.args as readonly unknown[])[2] as Hex);
  const envelope = hexBytes(envHex as Hex);
  const context = await arc.contextOf(publicClient, deployment, chainJobId);
  return verifyAndDecrypt(envelope, context, key, expected);
}

/** Both commitment checks, then authenticated decryption. Used live and, offline, by replay. */
export function verifyAndDecrypt(envelope: Uint8Array, context: Uint8Array, key: Hex, expected: { envelopeHash: string; keyCommitment: string }): Delivery {
  const keyBytes = hexBytes(key);
  const envelopeHashOk = envelopeHash(envelope).toLowerCase() === expected.envelopeHash.toLowerCase();
  const keyOk = keyCommitment(context, keyBytes).toLowerCase() === expected.keyCommitment.toLowerCase();
  if (!envelopeHashOk || !keyOk) return { files: [], envelopeHashOk, keyOk, envelope, context };
  return { files: decodeBundle(decryptEnvelope(envelope, keyBytes, context)), envelopeHashOk, keyOk, envelope, context };
}

export function hexBytes(h: Hex): Uint8Array {
  const s = h.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function formatUsdc(units: string | bigint): string {
  const v = BigInt(units);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} USDC`;
}
