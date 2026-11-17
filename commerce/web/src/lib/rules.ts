// Renders the engine's normalized rule preview (`engine validate` -> preview.rules) as readable text.
// The text comes from the canonical structure the engine checks, never from the model's prose.

type Node = Record<string, unknown>;

const CMP: Record<string, string> = { eq: "=", ne: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥", add: "+", sub: "−", mul: "×" };

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function collection(c: unknown): string {
  if (!isNode(c)) return "?";
  return `${String(c.file)}›${String(c.field)}${c.source === "reference" ? " (reference)" : c.source === "evidence" ? " (evidence)" : ""}`;
}

export function ruleText(e: unknown): string {
  if (!isNode(e)) return JSON.stringify(e);
  const op = String(e.op);
  switch (op) {
    case "literal":
      return e.type === "string" ? JSON.stringify(e.value) : String(e.value);
    case "field": {
      const where = e.source === "reference" ? "reference " : e.source === "evidence" ? "evidence " : "";
      return `${where}${String(e.file)}.${String(e.field)}`;
    }
    case "record_field":
      return `row.${String(e.field)}${typeof e.level === "number" && e.level > 0 ? `^${e.level}` : ""}`;
    case "not":
      return `not (${ruleText(e.value ?? e.operand)})`;
    case "and":
    case "or": {
      const parts = Array.isArray(e.operands) ? e.operands : [e.left, e.right];
      return parts.map((p) => `(${ruleText(p)})`).join(` ${op} `);
    }
    case "count":
      return `count(${collection(e.collection)}${e.where ? ` where ${ruleText(e.where)}` : ""})`;
    case "sum":
      return `sum(${collection(e.collection)}, ${ruleText(e.value)})`;
    case "all":
    case "any":
      return `${op} rows of ${collection(e.collection)}: ${ruleText(e.where)}`;
    case "unique":
      return `${String(e.field)} is unique in ${collection(e.collection)}`;
    case "lookup":
      return `${collection(e.collection)}[${String(e.keyField)} = ${ruleText(e.key)}].${String(e.valueField)}`;
    case "file_hash":
      return `sha256(${String(e.file)})`;
    case "file_size":
      return `size(${String(e.file)})`;
    default:
      if (op in CMP) return `${ruleText(e.left)} ${CMP[op]} ${ruleText(e.right)}`;
      return `${op}(${Object.entries(e)
        .filter(([k]) => k !== "op")
        .map(([k, v]) => `${k}: ${isNode(v) ? ruleText(v) : JSON.stringify(v)}`)
        .join(", ")})`;
  }
}
