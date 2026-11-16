import { join } from "node:path";
import { lstatSync } from "node:fs";
import type { Address } from "viem";
import { readSafeFile, requireSprint } from "./sprint-authorization.ts";

/** Call only while holding poster-writer.lock. The sibling journal owns its reservations forever.
 * A confirmed reservation still advances the nonce floor if the RPC pending count lags or history changes.
 * An unresolved sibling operation blocks new signing. Reading an existing hash remains permitted.
 */
export function siblingNonceReservations(directory: string, account: Address, caller: "funding" | "refund"): number[] {
  let value: any;
  try {value=JSON.parse(readSafeFile(join(directory,caller === "funding" ? "refund-journal.json" : "poster-funding.json"),true).toString());}
  catch(error) {
    if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    requireSprint(!lstatSync(join(directory,caller === "funding" ? "refund-journal-created" : "poster-funding-created"),{throwIfNoEntry:false}));
    return [];
  }
  requireSprint(value?.version === 1 && typeof value[caller === "funding" ? "account" : "buyer"] === "string" &&
    value[caller === "funding" ? "account" : "buyer"].toLowerCase() === account.toLowerCase());
  let entries: any[];
  if(caller === "funding") {requireSprint(Array.isArray(value.entries));entries=value.entries;}
  else {
    requireSprint(value.runs && typeof value.runs === "object" && !Array.isArray(value.runs));
    entries=Object.values(value.runs).flatMap((run:any)=>{requireSprint(Array.isArray(run.entries));return run.entries;});
  }
  return entries.map(entry=>{
    requireSprint(Number.isSafeInteger(entry.nonce) && entry.nonce >= 0 && entry.stage === "confirmed");
    return entry.nonce;
  });
}
