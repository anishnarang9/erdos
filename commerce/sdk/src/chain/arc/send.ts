// Sending. Works in Node and in a browser. The caller supplies a viem WalletClient with an account;
// this module never sees a private key.
import type { Hex, PublicClient, TransactionReceipt, WalletClient } from "viem";
import { withRetry } from "../retry.ts";
import { MIN_MAX_FEE_PER_GAS } from "./deployment.ts";
import { ArcError, describeRevert, isExecutionError, rpc } from "./errors.ts";
import type { RevertInfo } from "./errors.ts";
import { calldataBytes, submitGasLimit } from "./tx.ts";
import type { TxRequest } from "./tx.ts";

/**
 * Gas limit `sendTx` uses for `release` when none is given. A release is never estimated, because an
 * estimate would put the real key in an RPC call before the transaction exists. UNVERIFIED on Arc:
 * release runs hook.release, core.complete, two hook callbacks and one USDC transfer; 500,000 is a
 * generous bound until Nick measures it. Unused gas is not charged.
 */
export const DEFAULT_RELEASE_GAS = 500_000n;

/** How long `sendTx` waits for a receipt by default. Arc blocks take well under a second. */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;

export interface SendOptions {
  /** Explicit gas limit. See `sendTx` for the default per request. */
  gas?: bigint;
  /** Milliseconds to wait for the receipt. Defaults to 120,000. */
  receiptTimeoutMs?: number;
}

/** Fee fields for an Arc transaction. maxFeePerGas is never below the 20 gwei floor. */
export async function arcFees(pc: PublicClient): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const est = await rpc("fee estimate", () => pc.estimateFeesPerGas());
  const maxFeePerGas = est.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? est.maxFeePerGas : MIN_MAX_FEE_PER_GAS;
  const priority = est.maxPriorityFeePerGas ?? 0n;
  return { maxFeePerGas, maxPriorityFeePerGas: priority < maxFeePerGas ? priority : maxFeePerGas };
}

function reverted(req: TxRequest, err: unknown, txHash?: Hex): ArcError {
  const info: RevertInfo = isExecutionError(err) ? describeRevert(err) : { text: "unknown reason" };
  const where = txHash ? `transaction ${txHash} (${req.label}) reverted` : `${req.label} would revert`;
  return new ArcError("reverted", `${where}: ${info.text}`, {
    cause: err,
    ...(info.revertName !== undefined ? { revertName: info.revertName } : {}),
    ...(txHash !== undefined ? { txHash } : {}),
  });
}

/**
 * Sends one transaction request and waits for its receipt.
 *
 * - Fees: `arcFees`, so maxFeePerGas is at least 20 gwei (Arc drops anything lower without a receipt).
 * - Gas is always explicit: the `gas` argument when given; else `submitGasLimit` for `submit` and
 *   `DEFAULT_RELEASE_GAS` for `release`; else eth_estimateGas plus 25%. An estimate that reverts
 *   throws ArcError("reverted") and nothing is sent.
 * - A `release` request is never passed to eth_call, eth_estimateGas or eth_fillTransaction before
 *   it is broadcast. With a local account the transaction is signed locally and sent raw.
 * - A mined transaction that reverted throws ArcError("reverted") with `txHash` and, when the revert
 *   can be reproduced by an eth_call at the same block, `revertName`.
 * - A broadcast transaction whose receipt does not arrive within `receiptTimeoutMs` throws
 *   ArcError("rpc") with `txHash`. The transaction may still be mined later.
 *
 * The last argument is a gas limit, or `{ gas?, receiptTimeoutMs? }`.
 */
export async function sendTx(
  pc: PublicClient,
  wallet: WalletClient,
  req: TxRequest,
  gasOrOptions?: bigint | SendOptions,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const options: SendOptions = typeof gasOrOptions === "bigint" ? { gas: gasOrOptions } : (gasOrOptions ?? {});
  const gas = options.gas;
  const account = wallet.account;
  if (!account) throw new ArcError("bad_input", "the WalletClient has no account");
  if (wallet.chain && wallet.chain.id !== req.chainId) {
    throw new ArcError("wrong_chain", `the wallet is on chain ${wallet.chain.id}, the request is for chain ${req.chainId}`);
  }
  const rpcChainId = await rpc("eth_chainId", () => pc.getChainId());
  if (rpcChainId !== req.chainId) throw new ArcError("wrong_chain", `RPC chain ID ${rpcChainId}, the request is for chain ${req.chainId}`);

  let gasLimit: bigint;
  if (gas !== undefined) {
    if (gas <= 0n) throw new ArcError("bad_input", "gas must be above zero");
    gasLimit = gas;
  } else if (req.label === "submit") {
    gasLimit = submitGasLimit(calldataBytes(req));
  } else if (req.label === "release") {
    gasLimit = DEFAULT_RELEASE_GAS;
  } else {
    let estimate: bigint;
    try {
      estimate = await withRetry(() => pc.estimateGas({ account: account.address, to: req.to, data: req.data }));
    } catch (err) {
      if (isExecutionError(err)) throw reverted(req, err);
      throw new ArcError("rpc", `eth_estimateGas of ${req.label} failed`, { cause: err });
    }
    gasLimit = (estimate * 125n) / 100n;
  }

  const fees = await arcFees(pc);

  let hash: Hex;
  try {
    if (account.type === "local" && account.signTransaction) {
      const nonce = await withRetry(() => pc.getTransactionCount({ address: account.address, blockTag: "pending" }));
      const serializedTransaction = await account.signTransaction({
        type: "eip1559",
        chainId: req.chainId,
        to: req.to,
        data: req.data,
        value: 0n,
        gas: gasLimit,
        nonce,
        ...fees,
      });
      hash = await wallet.sendRawTransaction({ serializedTransaction });
    } else {
      hash = await wallet.sendTransaction({ account, chain: wallet.chain ?? null, to: req.to, data: req.data, value: 0n, gas: gasLimit, ...fees });
    }
  } catch (err) {
    if (isExecutionError(err)) throw reverted(req, err);
    throw new ArcError("rpc", `sending ${req.label} failed`, { cause: err });
  }

  // From here on the transaction is broadcast: every error carries its hash.
  let receipt: TransactionReceipt;
  try {
    receipt = await withRetry(() => pc.waitForTransactionReceipt({ hash, timeout: options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS }));
  } catch (err) {
    throw new ArcError("rpc", `no receipt for ${hash} (${req.label}); on Arc a missing receipt usually means maxFeePerGas was below 20 gwei`, { cause: err, txHash: hash });
  }
  if (receipt.status !== "success") {
    // The transaction is mined, so its calldata is already public: replaying it reveals nothing new.
    let cause: unknown;
    try {
      await withRetry(() => pc.call({ account: account.address, to: req.to, data: req.data, gas: gasLimit, blockNumber: receipt.blockNumber }));
    } catch (err) {
      cause = err;
    }
    throw reverted(req, cause, hash);
  }
  return { hash, receipt };
}
