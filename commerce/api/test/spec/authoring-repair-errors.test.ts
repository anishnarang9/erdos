import { expect, it } from "vitest";
import { explainRepairErrors } from "../../src/authoring-repair-errors.ts";

it("explains a numeric lookup used as a Boolean operand at the engine error path", () => {
  const plan = { rules: [{ op: "all", where: {
    op: "and", left: { op: "lookup", valueField: "expectedCents" },
    right: { op: "eq" },
  } }] };
  const errors = [{ path: "/plan/rules/0/where", message: "Operand types do not match the operation" }];

  expect(explainRepairErrors(plan, errors)).toEqual([{ path: "/plan/rules/0/where",
    message: "Operand types do not match the operation. The left lookup returns a value. Compare it with a typed value before using it in and." }]);
  expect(errors[0]?.message).toBe("Operand types do not match the operation");
});

it("does not add a lookup hint to unrelated type errors", () => {
  const plan = { rules: [{ op: "all", where: { op: "and", left: { op: "eq" }, right: { op: "eq" } } }] };
  const errors = [{ path: "/plan/rules/0/where", message: "Operand types do not match the operation" }];
  expect(explainRepairErrors(plan, errors)).toEqual(errors);
});

it("explains a lookup used directly as an all predicate", () => {
  const plan = { rules: [{ op: "all", where: { op: "lookup", valueField: "maxDay" } }] };
  const errors = [{ path: "/plan/rules/0/where", message: "Operand types do not match the operation" }];
  expect(explainRepairErrors(plan, errors)).toEqual([{ path: "/plan/rules/0/where",
    message: "Operand types do not match the operation. A lookup returns a value. Compare it with a typed value before using it as an all predicate." }]);
});

it("names the any predicate when a lookup is used as its Boolean test", () => {
  const plan = { rules: [{ op: "any", where: { op: "lookup", valueField: "expectedCents" } }] };
  const errors = [{ path: "/plan/rules/0/where", message: "Operand types do not match the operation" }];
  expect(explainRepairErrors(plan, errors)[0]?.message).toContain("as an any predicate");
});

it("explains the Boolean requirement at the aggregate node reported by native validation", () => {
  const plan = { rules: [{ op: "all", where: { op: "lookup" } }] };
  const errors = [{ path: "/plan/rules/0", message: "Collection expression has the wrong type" }];
  expect(explainRepairErrors(plan, errors)[0]?.message).toContain(
    "The all where expression must return bool. Compare the lookup result with a value of the same type.",
  );
});

it("explains the numeric requirement for a lookup inside sum", () => {
  const plan = { rules: [{ op: "lte", left: { op: "sum", value: { op: "lookup" } } }] };
  const errors = [{ path: "/plan/rules/0/left", message: "Collection expression has the wrong type" }];
  expect(explainRepairErrors(plan, errors)[0]?.message).toContain(
    "The sum value expression must return i64. Check the lookup valueField declaration against the supplied reference.",
  );
});

it("explains an invalid record scope without changing the plan", () => {
  const plan = { rules: [{ op: "all", where: { op: "eq", right: { op: "record_field", field: "zone", level: 1 } } }] };
  const errors = [{ path: "/plan/rules/0/where/right", message: "Record field is outside its collection scope" }];
  expect(explainRepairErrors(plan, errors)[0]?.message).toContain(
    "A lookup does not introduce a scope. Use its result to read a matched reference field.",
  );
});
