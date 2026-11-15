import canonicalize from "canonicalize";
import { sha256 } from "./context.ts";

export type PlanValidator = (plan: unknown) => Promise<
  | { ok: true }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown }
>;

export type OutputFormat = "json" | "text" | "binary";

export interface Revision {
  plan: unknown;
  referenceDigest: string;
  outputs: { name: string; format: OutputFormat }[];
  expirySeconds: number;
  maxBudget: string;
}

export interface FieldError {
  path: string;
  message: string;
}

export const REVISION_HASH_DOMAIN = "UBC26/revision/v1";
export const MAX_BUDGET = 1_000_000_000_000n;

const REVISION_KEYS = ["plan", "referenceDigest", "outputs", "expirySeconds", "maxBudget"] as const;
const OUTPUT_KEYS = ["name", "format"] as const;
const OUTPUT_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const DIGEST_RE = /^0x[0-9a-fA-F]{64}$/;
const BUDGET_RE = /^[1-9][0-9]*$/;
const FORMATS: readonly string[] = ["json", "text", "binary"];

/** SIMULATED until the engine publishes `engine validate` output: any object with a number or string `version`. */
export const simulatedValidatePlan: PlanValidator = async (plan) => {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return { ok: false, kind: "invalid", errors: [{ path: "/plan", message: "plan must be a JSON object" }] };
  }
  const version = (plan as Record<string, unknown>).version;
  if (typeof version !== "number" && typeof version !== "string") {
    return {
      ok: false,
      kind: "invalid",
      errors: [{ path: "/plan/version", message: "plan.version must be a number or a string" }],
    };
  }
  return { ok: true };
};

/** revisionHash = "0x" + hex(SHA256(UTF8("UBC26/revision/v1") || UTF8(JCS(revision)))), referenceDigest lowercased. */
export function revisionHash(revision: Revision): string {
  const normalized = { ...revision, referenceDigest: revision.referenceDigest.toLowerCase() };
  const jcs = canonicalize(normalized);
  if (jcs === undefined) throw new Error("revision is not JSON-serializable");
  return "0x" + sha256(Buffer.from(REVISION_HASH_DOMAIN + jcs, "utf8")).toString("hex");
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pointer(...parts: (string | number)[]): string {
  return parts.map((p) => "/" + String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("");
}

/**
 * Checks every revision field except `plan` (which the PlanValidator owns, though it must be present).
 * Paths are JSON Pointers relative to the revision object, matching the validator's `/plan...` paths.
 * Returns the normalized revision (referenceDigest lowercased) or the full error list.
 */
export function validateRevisionShape(
  input: unknown,
): { ok: true; revision: Revision } | { ok: false; errors: FieldError[] } {
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: "", message: "revision must be a JSON object" }] };
  const errors: FieldError[] = [];

  for (const k of Object.keys(input)) {
    if (!(REVISION_KEYS as readonly string[]).includes(k)) errors.push({ path: pointer(k), message: "unknown field" });
  }

  if (!("plan" in input)) errors.push({ path: "/plan", message: "required" });

  const digest = input.referenceDigest;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    errors.push({ path: "/referenceDigest", message: "must be 0x followed by 64 hex characters (32 bytes)" });
  }

  const outputs = input.outputs;
  if (!Array.isArray(outputs)) {
    errors.push({ path: "/outputs", message: "must be an array of 1-16 entries" });
  } else {
    if (outputs.length < 1 || outputs.length > 16) {
      errors.push({ path: "/outputs", message: "must have 1-16 entries" });
    }
    const seen = new Set<string>();
    outputs.forEach((o: unknown, i) => {
      if (!isPlainObject(o)) {
        errors.push({ path: pointer("outputs", i), message: "must be an object { name, format }" });
        return;
      }
      for (const k of Object.keys(o)) {
        if (!(OUTPUT_KEYS as readonly string[]).includes(k)) {
          errors.push({ path: pointer("outputs", i, k), message: "unknown field" });
        }
      }
      const name = o.name;
      if (typeof name !== "string" || !OUTPUT_NAME_RE.test(name) || name === "." || name === "..") {
        errors.push({
          path: pointer("outputs", i, "name"),
          message: "must match ^[A-Za-z0-9._-]{1,128}$ and not be '.' or '..'",
        });
      } else if (seen.has(name)) {
        errors.push({ path: pointer("outputs", i, "name"), message: "duplicate output name" });
      } else {
        seen.add(name);
      }
      if (typeof o.format !== "string" || !FORMATS.includes(o.format)) {
        errors.push({ path: pointer("outputs", i, "format"), message: "must be one of json, text, binary" });
      }
    });
  }

  const expiry = input.expirySeconds;
  if (typeof expiry !== "number" || !Number.isInteger(expiry) || expiry < 300 || expiry > 86400) {
    errors.push({ path: "/expirySeconds", message: "must be an integer from 300 to 86400" });
  }

  const budget = input.maxBudget;
  if (typeof budget !== "string" || !BUDGET_RE.test(budget) || BigInt(budget) > MAX_BUDGET) {
    errors.push({
      path: "/maxBudget",
      message: "must be a decimal string, a positive integer at most 1000000000000, no leading zeros",
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    revision: {
      plan: input.plan,
      referenceDigest: (digest as string).toLowerCase(),
      outputs: (outputs as { name: string; format: OutputFormat }[]).map((o) => ({ name: o.name, format: o.format })),
      expirySeconds: expiry as number,
      maxBudget: budget as string,
    },
  };
}
