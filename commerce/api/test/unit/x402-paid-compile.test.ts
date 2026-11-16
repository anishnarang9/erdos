import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app.ts";
import { httpX402Facilitator } from "../../src/x402.ts";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Address, type Hex } from "viem";
import { BUYER_TOKEN, T0, type SpecApp } from "../spec/helpers.ts";
import { EMPTY_REF_HASH, approveOk, countingEngine, createJob56, json, req, revisionWith } from "../spec/helpers-t56.ts";

const asset = "0x3600000000000000000000000000000000000000" as Address;
const payTo = "0x1111111111111111111111111111111111111111" as Address;
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const types = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;
let nonce = 0;
function facilitator() {
  let settlements = 0;
  let uncertain = false;
  return {
    get settlements() { return settlements; },
    set uncertain(v: boolean) { uncertain = v; },
    async settle(p: any, q: any) {
      settlements++;
      if (uncertain) throw new Error("settlement outcome unknown");
      const a = p.payload.authorization;
      const signed = await verifyTypedData({ address: payer.address,
        domain: { name: "USD Coin", version: "2", chainId: 5042002, verifyingContract: asset },
        types, primaryType: "TransferWithAuthorization",
        message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
        signature: p.payload.signature });
      return { success: signed && a.to === q.payTo && a.value === q.amount, payer: payer.address,
        transaction: "0x" + "ab".repeat(32), network: q.network };
    },
  };
}
function setup(engine = countingEngine(), f = facilitator(), dbPath = ":memory:", amount = "10000") {
  const made = createApp({ dbPath, buyerToken: BUYER_TOKEN, now: () => T0, engine,
    x402: { resourceBaseUrl: "https://api.example.test", network: "eip155:5042002", asset,
      payTo, amount, extra: { name: "USD Coin", version: "2" }, facilitator: f } } as any);
  const s: SpecApp = { app: made.app, close: made.close, clock: { t: T0 } };
  opened.push(s);
  return { s, engine, f };
}
const opened: SpecApp[] = [];
const dirs: string[] = [];
afterEach(() => { for (const s of opened.splice(0)) s.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function job(s: SpecApp) {
  const j = await createJob56(s, revisionWith(EMPTY_REF_HASH));
  await approveOk(s, j.jobId, j.revisionHash, EMPTY_REF_HASH);
  return j;
}
async function request(s: SpecApp, j: {jobId:string;revisionHash:string}, payload?: unknown) {
  return req(s, "POST", `/v1/jobs/${j.jobId}/paid-compile`, {revisionHash:j.revisionHash},
    payload ? {"payment-signature":Buffer.from(JSON.stringify(payload)).toString("base64")} : {});
}
async function signed(challenge: Response) {
  const q = JSON.parse(Buffer.from(challenge.headers.get("payment-required")!, "base64").toString("utf8"));
  const a = q.accepts[0];
  const authorization = { from:payer.address, to:a.payTo, value:a.amount,
    validAfter:String(T0/1000-1), validBefore:String(T0/1000+3600),
    nonce:("0x"+(++nonce).toString(16).padStart(64,"0")) as Hex };
  const signature = await payer.signTypedData({ domain:{name:"USD Coin",version:"2",chainId:5042002,verifyingContract:asset},
    types,primaryType:"TransferWithAuthorization",message:{...authorization,value:BigInt(a.amount),validAfter:BigInt(authorization.validAfter),validBefore:BigInt(authorization.validBefore)} });
  return { q, p: {x402Version:2 as const,resource:q.resource,accepted:a,payload:{signature,authorization},extensions:{}} };
}

it("quotes exact Arc payment before compilation", async () => {
  const {s,engine,f}=setup(); const j=await job(s); const r=await request(s,j);
  expect(r.status).toBe(402);
  const {q}=await signed(r);
  expect(q.x402Version).toBe(2);
  expect(q.resource.url).toBe(`https://api.example.test/v1/jobs/${j.jobId}/paid-compile`);
  expect(q.accepts).toEqual([{scheme:"exact",network:"eip155:5042002",asset,payTo,amount:"10000",maxTimeoutSeconds:60,
    extra:{name:"USD Coin",version:"2",paymentFlow:"upfront"}}]);
  expect(engine.compileCalls).toHaveLength(0); expect(f.settlements).toBe(0);
});

it("settles a signed retry once and replays the same result", async () => {
  const {s,engine,f}=setup(); const j=await job(s); const {p}=await signed(await request(s,j));
  const first=await request(s,j,p); expect(first.status,await first.clone().text()).toBe(200);
  expect(first.headers.get("payment-response")).toBeTruthy();
  const replay=await request(s,j,p); expect(replay.status).toBe(200);
  expect(await json(replay)).toEqual(await json(first));
  expect(replay.headers.get("idempotent-replayed")).toBe("true");
  expect(f.settlements).toBe(1);expect(engine.compileCalls).toHaveLength(1);
});

it("retries compilation after payment without another charge", async () => {
  let n=0; const engine=countingEngine({compile:async input=>{
    if(++n===1) throw new Error("transient compile failure");
    return await countingEngine().compile(input);
  }});
  const f=facilitator();const {s}=setup(engine,f);const j=await job(s);const {p}=await signed(await request(s,j));
  expect((await request(s,j,p)).status).toBe(502);
  expect((await request(s,j,p)).status).toBe(200);
  expect(f.settlements).toBe(1);expect(engine.compileCalls).toHaveLength(2);
});

it("rejects changed quote and holds uncertain settlement without resending", async () => {
  const f=facilitator();const {s}=setup(countingEngine(),f);const j=await job(s);const {p}=await signed(await request(s,j));
  expect((await request(s,j,{...p,accepted:{...p.accepted,amount:"1"}})).status).toBe(402);
  expect(f.settlements).toBe(0);
  f.uncertain=true;
  expect((await request(s,j,p)).status).toBe(409);
  expect((await request(s,j,p)).status).toBe(409);
  expect(f.settlements).toBe(1);
});

it("recovers a paid compile after process restart without another settlement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ubc26-x402-")); dirs.push(dir);
  let n = 0;
  const engine = countingEngine({ compile: async input => {
    if (++n === 1) throw new Error("transient compile failure");
    return countingEngine().compile(input);
  } });
  const f = facilitator();
  const dbPath = join(dir, "api.db");
  const firstApp = setup(engine, f, dbPath); const j = await job(firstApp.s);
  const { p } = await signed(await request(firstApp.s, j));
  expect((await request(firstApp.s, j, p)).status).toBe(502);
  firstApp.s.close();
  const secondApp = setup(engine, f, dbPath);
  const second = await request(secondApp.s, j, p);
  expect(second.status, await second.clone().text()).toBe(200);
  expect(second.headers.get("payment-response")).toBeTruthy();
  expect(f.settlements).toBe(1);
  expect(engine.compileCalls).toHaveLength(2);
});

it("retries an already paid compile after a price change without another charge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ubc26-x402-price-")); dirs.push(dir);
  let n = 0;
  const engine = countingEngine({ compile: async input => {
    if (++n === 1) throw new Error("transient compile failure");
    return countingEngine().compile(input);
  } });
  const f = facilitator(); const dbPath = join(dir, "api.db");
  const firstApp = setup(engine, f, dbPath); const j = await job(firstApp.s);
  const { p } = await signed(await request(firstApp.s, j));
  expect((await request(firstApp.s, j, p)).status).toBe(502);
  firstApp.s.close();
  const secondApp = setup(engine, f, dbPath, "20000");
  expect((await request(secondApp.s, j, p)).status).toBe(200);
  expect(f.settlements).toBe(1);
});

it("does not quote or settle an unapproved job", async () => {
  const { s, f } = setup();
  const j = await createJob56(s, revisionWith(EMPTY_REF_HASH));
  const r = await request(s, j);
  expect(r.status).toBe(409);
  expect(r.headers.get("payment-required")).toBeNull();
  expect(f.settlements).toBe(0);
});

it("does not reuse one signed transfer for another job", async () => {
  const { s, f } = setup(); const first = await job(s); const second = await job(s);
  const { p } = await signed(await request(s, first));
  expect((await request(s, first, p)).status).toBe(200);
  const secondQuote = await signed(await request(s, second));
  const reused = { ...p, resource: secondQuote.q.resource, accepted: secondQuote.q.accepts[0] };
  expect((await request(s, second, reused)).status).toBe(409);
  expect(f.settlements).toBe(1);
});

it("sends the x402 v2 settle envelope to the configured facilitator", async () => {
  const { s } = setup(); const j = await job(s);
  const { p } = await signed(await request(s, j));
  let seenUrl = "";
  let seenBody: unknown;
  const client = httpX402Facilitator({ url: "https://facilitator.example.test/v1/x402", fetch: async (url, init) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return Response.json({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:5042002", payer: payer.address });
  } });
  const result = await client.settle(p, p.accepted);
  expect(result.success).toBe(true);
  expect(seenUrl).toBe("https://facilitator.example.test/v1/x402/settle");
  expect(seenBody).toEqual({ x402Version: 2, paymentPayload: p, paymentRequirements: p.accepted });
});
