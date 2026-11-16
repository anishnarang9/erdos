// Typed open-claim acceptance entry. Invoke runOpenClaimAcceptance with an injected EngineRunner.
// Do not set spawnEngine. This module does not start the engine binary or a guest build.
// The parent owns the first combined proof run.
import { WorkerCheckError } from "../run.ts";
import { OPEN_CLAIM_ABI_STATUS, OPEN_CLAIM_INTERFACE_REVISION, OPEN_CLAIM_SYNTHETIC } from "./fixture.ts";
import { runOpenClaim } from "./run.ts";
import type { OpenClaimRunOptions } from "./types.ts";

export function planOpenClaimEngineAcceptance() {
  return {
    mode: "open-claim" as const,
    spawnsEngine: false as const,
    evidence: OPEN_CLAIM_ABI_STATUS,
    interfaceRevision: OPEN_CLAIM_INTERFACE_REVISION,
    context: OPEN_CLAIM_SYNTHETIC.context,
    flags: ["prove", "--package", "--job", "--deliverables", "--reference", "--out"] as const,
  };
}

export async function runOpenClaimAcceptance(options: OpenClaimRunOptions & { spawnEngine?: boolean }) {
  if (options.spawnEngine === true) {
    throw new WorkerCheckError("engine", "open-claim acceptance does not spawn the engine; pass an injected EngineRunner");
  }
  if (!options.runner || typeof options.runner.run !== "function") {
    throw new WorkerCheckError("engine", "an injected engine runner is required");
  }
  return runOpenClaim(options);
}
