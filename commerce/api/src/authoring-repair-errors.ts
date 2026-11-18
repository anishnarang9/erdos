import type { FieldError } from "./revision.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function atPlanPath(plan: unknown, path: string): unknown {
  if (!path.startsWith("/plan/")) return undefined;
  let value: unknown = plan;
  for (const part of path.slice(6).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value) && /^\d+$/.test(key)) value = value[Number(key)];
    else if (object(value)) value = value[key];
    else return undefined;
  }
  return value;
}

/** Add a precise repair hint only when the native error path identifies this shape. */
export function explainRepairErrors(plan: unknown, errors: FieldError[]): FieldError[] {
  return errors.map(error => {
    if (error.message !== "Operand types do not match the operation") return error;
    const node = atPlanPath(plan, error.path);
    const parent = atPlanPath(plan, error.path.replace(/\/where$/, ""));
    if (object(node) && node.op === "lookup" && object(parent) && (parent.op === "all" || parent.op === "any")) {
      return { ...error, message: `${error.message}. A lookup returns a value. Compare it with a typed value before using it as an ${parent.op} predicate.` };
    }
    if (!object(node) || (node.op !== "and" && node.op !== "or")) return error;
    const side = object(node.left) && node.left.op === "lookup" ? "left"
      : object(node.right) && node.right.op === "lookup" ? "right" : null;
    if (!side) return error;
    return { ...error, message: `${error.message}. The ${side} lookup returns a value. Compare it with a typed value before using it in ${node.op}.` };
  });
}
