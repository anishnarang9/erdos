# Synthetic task allocation and dispatch

Status: proposed rehearsal workload, dated 2026-11-15. Buyer approval is pending.
All identifiers, costs, capacities, and time values are synthetic.
This request does not authorize funding or any live transaction.

## Goal

Allocate every task in `catalog.json` to one pool.
Choose one dispatch record for every pool, including unused pools.
Return `allocations.json` and `dispatch.json`.
Any feasible solution is acceptable. No optimization or particular assignment is required.

## Input and output types

The committed reference file is `catalog.json`.
It contains a `budget` scalar, a `tasks` array, and a `pools` array.
Pool capacity counts tasks, not units.
Costs use fictional integer credits per unit.
Dispatch times, deadlines, cutoffs, and guard starts use the same fictional integer ticks.
They do not represent wall-clock time.

`allocations.json` contains an `allocations` array.
Each record contains these required fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `task_id` | string | Reference task identifier |
| `pool_id` | string | Reference pool identifier |
| `units` | i64 string | Units assigned to that task |

`dispatch.json` contains a `dispatches` array.
Each record contains these required fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `pool_id` | string | Reference pool identifier |
| `mode` | string | Either `open` or `guarded` |
| `stamp` | i64 string | Dispatch tick shared by tasks assigned to this pool |

An i64 string uses normalized signed decimal notation in a JSON string.
Examples include `"0"`, `"7"`, and `"-2"`.
Reject JSON numbers, fractions, leading zeros, plus signs, whitespace inside numbers, and `"-0"`.
Values must fit the signed 64-bit range.
Reference `special` and `certified` values are JSON booleans.
Identifiers and modes are case-sensitive.

Extra object members are allowed. Ignore them when checking these requirements.
Array order and object-member order do not affect acceptance.
Both roots and all records must be JSON objects.
All declared fields and arrays must exist with the specified types.
Use valid UTF-8 JSON with unique object-member names and valid Unicode strings.
Reject nonfinite numbers, including numeric overflow, even in extra members.
Every array has at most 256 entries, including arrays in extra members.
The maximum JSON depth is 32, counting the root as depth 1.
Count each object value or array element as one additional depth level.

## Acceptance requirements

1. The recovered directory contains exactly the two output files named above.
   Reject symlinks, nested directories, missing files, renamed files, and additional entries.
2. Include every reference task exactly once in `allocations`.
   Reject duplicate, missing, or foreign task identifiers.
   Every allocation must name a reference pool.
3. Include every reference pool exactly once in `dispatches`.
   Reject duplicate, missing, or foreign pool identifiers.
4. Each allocation's `units` must equal its reference task's `units`.
5. The selected pool's `tier` must be greater than or equal to the task's `min_tier`.
6. If a task is special, both conditions below must hold:
   - The selected pool is certified.
   - That pool's dispatch mode is `guarded`.
   Non-special tasks do not require certification or guarded dispatch.
7. Each dispatch mode must be `open` or `guarded`.
   Each dispatch stamp must be greater than or equal to zero.
   Each dispatch stamp must be less than or equal to its reference pool's `cutoff`.
8. If a dispatch mode is `guarded`, its stamp must be greater than or equal to that pool's `guard_start`.
   An open dispatch does not have this lower bound.
9. For each task, the selected pool's dispatch stamp must be strictly less than that task's `deadline`.
   Equality fails, even when the pool's cutoff permits that stamp.
10. For each pool, the count of allocations naming that pool must not exceed its `capacity`.
11. Sum `allocation.units * selected_pool.unit_cost` over all allocations.
    The sum must not exceed the reference `budget`.
    Budget equality passes. Unused pools add no cost.
    Use checked signed 64-bit integer arithmetic.
12. Each collection contains at most 256 records.
    The encoded delivery bundle must contain at most 16,384 bytes, including filenames and headers.
    Preserve the submitted file bytes when measuring this limit.

## Scope

Check feasibility against this synthetic reference only.
Do not request external facts, network access, signatures, secrets, or additional evidence.
The result does not claim research quality, real availability, or an optimal allocation.
