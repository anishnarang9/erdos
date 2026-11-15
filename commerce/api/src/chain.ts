// T7/T8 chain dependency for the API. Owner: Coder D. Implement per ../CONTRACT-T5-T8.md §5–6.
// SIMULATED: ABI is the @ubc26/sdk stub until Nick publishes the settlement ABI.
import type { PublicClient } from "viem";
import type { ChainConfig } from "@ubc26/sdk";

export interface ApiChain {
  config: ChainConfig;
  publicClient: PublicClient;
}
