import { expect, it } from "vitest";
import { attemptStatus } from "../../src/open-claim/attempt-status.ts";
const state = () => ({ version:1, mode:"open-claim", attemptId:"7e5a0427-f47c-4508-b041-42a9ff58993e", phase:"rejected", jobId:"7",
  binding:{chainId:5042002,core:"0x"+"11".repeat(20),adapter:"0x"+"22".repeat(20),solver:"0x"+"33".repeat(20)},paymentConfirmed:false,
  log:[{at:"2026-11-16T12:00:00.000Z",event:"proving",detail:"private-key /private/path"},{at:"2026-11-16T12:00:01.000Z",event:"rejected"}],
  releaseKey:"secret",attemptDirectory:"/private/operator" });
it("exposes per-attempt failure and cursor without private fields or log details", () => {
  const view=attemptStatus(state());
  expect(view).toMatchObject({attemptId:state().attemptId,phase:"rejected",paymentConfirmed:false,nextCursor:2});
  expect(JSON.stringify(view)).not.toContain("private");expect(JSON.stringify(view)).not.toContain("secret");
  expect(view.events.map(e=>e.cursor)).toEqual([1,2]);
});
it("resumes events with an explicit per-attempt cursor", () => {
  const view=attemptStatus(state(),1);expect(view.events).toHaveLength(1);expect(view.events[0]!.attemptId).toBe(state().attemptId);
  expect(()=>attemptStatus(state(),3)).toThrow();
});
it("rejects arbitrary event text and malformed identities", () => {
  const s=state();s.log[0]!.event="password-is-secret";expect(()=>attemptStatus(s)).toThrow();
  const other=state();other.attemptId="../../private";expect(()=>attemptStatus(other)).toThrow();
});
