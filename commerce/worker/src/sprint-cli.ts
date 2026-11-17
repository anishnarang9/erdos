// This sprint CLI supports native POSIX engines only. WSL fails closed.
// Configure config.engine with the executable path, executableSha256, wrapperSha256, and explicit environment.
// Independently review the candidate digest from sprintEngineWrapperDigest before approving the configuration.
// ENGINE_* variables do not select the executable. No CLI or environment flag bypasses source validation.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireSprint } from "./sprint-authorization.ts";

export type SprintAction = "inspect" | "prepare" | "check-deployment" | "fund" | "run" | "recover" | "verify";
export interface SprintArgs {
  action: SprintAction;
  input?: string; config?: string; runDir?: string; plan?: string; approval?: string;
  authorization?: string; apiJob?: string; quote?: string; keystore?: string;
  buyerTokenFd?: number; passwordFd?: number;
}
const flagNames = {
  input: "input", config: "config", "run-dir": "runDir", plan: "plan", approval: "approval",
  authorization: "authorization", "api-job": "apiJob", quote: "quote", keystore: "keystore",
  "buyer-token-fd": "buyerTokenFd", "password-fd": "passwordFd",
} as const;
export function parseSprintArgs(argv: string[]): SprintArgs {
  const action = argv[0];
  requireSprint(["inspect", "prepare", "check-deployment", "fund", "run", "recover", "verify"].includes(action ?? ""));
  const result: Record<string, string | number> = { action: action! };
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!;
    requireSprint(/^--[a-z-]+$/.test(flag) && Object.hasOwn(flagNames, flag.slice(2)));
    const key = flagNames[flag.slice(2) as keyof typeof flagNames];
    const value = argv[i + 1];
    requireSprint(value && !value.startsWith("--") && !/[\x00-\x1f]/.test(value) && !Object.hasOwn(result, key));
    if (key === "passwordFd" || key === "buyerTokenFd") {
      requireSprint(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 3);
      result[key] = Number(value);
    } else result[key] = value;
  }
  const allowed = {
    inspect: [], prepare: ["plan", "approval", "apiJob", "quote", "buyerTokenFd"],
    "check-deployment": [], fund: ["authorization", "keystore", "passwordFd", "buyerTokenFd"],
    run: ["authorization", "keystore", "passwordFd"], recover: [], verify: [],
  }[action as SprintAction];
  requireSprint(Object.keys(result).every(k => ["action", "input", "config", "runDir", ...allowed].includes(k)));
  requireSprint(result.passwordFd === undefined || result.passwordFd !== result.buyerTokenFd);
  return result as unknown as SprintArgs;
}

export async function sprintCli(argv: string[], dependencies?: import("./sprint-runner.ts").SprintDependencies): Promise<unknown> {
  const args = parseSprintArgs(argv);
  requireSprint(args.input && args.config && args.runDir);
  const { executeSprint } = await import("./sprint-runner.ts");
  return executeSprint(args, dependencies);
}
export async function sprintMain(argv = process.argv.slice(2)): Promise<void> {
  try {
    const report = await sprintCli(argv);
    console.log(JSON.stringify(report, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2));
  } catch {
    console.error("Sprint command failed. Details are redacted. Funding errors can leave allowance. Reconcile durable hashes and allowance before retrying.");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void sprintMain();
