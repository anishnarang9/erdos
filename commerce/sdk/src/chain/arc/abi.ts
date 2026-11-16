// Reuse Nick's exported contract artifacts; do not substitute the simulated SDK ABI.
export { coreAbi as arcCoreAbi, settlementHookAbi as arcHookAbi } from "./nick-examples/abi.ts";
export { erc20Abi as arcErc20Abi } from "viem";
