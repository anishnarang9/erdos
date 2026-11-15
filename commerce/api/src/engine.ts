// T6 engine boundary. Owner: Coder C. Implement per ../CONTRACT-T5-T8.md §1.
// SIMULATED until Anish publishes the engine CLI output shapes (Q-A2, Q-A3, Q-A4).
import type { Hex } from "viem";
import type { BundleFile } from "@ubc26/sdk";
import type { PlanValidator } from "./revision.ts";

export interface Manifest {
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  structureHash: Hex;
  toolchain: Record<string, string>;
  files: { name: string; sha256: Hex }[];
}

export type ValidateResult = Awaited<ReturnType<PlanValidator>>;

export type CompileResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown };

export interface Engine {
  validate(plan: unknown): Promise<ValidateResult>;
  compile(input: { plan: unknown; reference: BundleFile[] }): Promise<CompileResult>;
}
