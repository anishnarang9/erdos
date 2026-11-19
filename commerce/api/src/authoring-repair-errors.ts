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
    const node = atPlanPath(plan, error.path);
    if (!object(node)) return error;
    const explain = (hint: string) => ({ ...error, message: `${error.message}. ${hint}` });
    if (error.message === "Record field is outside its collection scope" && node.op === "record_field") {
      return explain("Level 0 reads the innermost collection row. Level 1 requires an enclosing collection row. A lookup does not introduce a scope. Use its result to read a matched reference field.");
    }
    if (error.message === "Collection expression has the wrong type") {
      if (node.op === "sum") {
        return explain("The sum value expression must return i64." +
          (object(node.value) && node.value.op === "lookup"
            ? " Check the lookup valueField declaration against the supplied reference." : ""));
      }
      if (node.op === "all" || node.op === "any" || node.op === "count") {
        return explain(`The ${node.op} where expression must return bool.` +
          (object(node.where) && node.where.op === "lookup"
            ? " Compare the lookup result with a value of the same type." : ""));
      }
      return error;
    }
    if (error.message !== "Operand types do not match the operation") return error;
    const parent = atPlanPath(plan, error.path.replace(/\/where$/, ""));
    if (node.op === "lookup" && object(parent) && (parent.op === "all" || parent.op === "any")) {
      return { ...error, message: `${error.message}. A lookup returns a value. Compare it with a typed value before using it as an ${parent.op} predicate.` };
    }
    if (node.op !== "and" && node.op !== "or") return error;
    const side = object(node.left) && node.left.op === "lookup" ? "left"
      : object(node.right) && node.right.op === "lookup" ? "right" : null;
    if (!side) return error;
    return { ...error, message: `${error.message}. The ${side} lookup returns a value. Compare it with a typed value before using it in ${node.op}.` };
  });
}
