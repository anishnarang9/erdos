// Recorded runs (Codex product-plan §6.4). The recorder snapshots the store while live; replay plays the
// snapshots back with their real timing. Replay never calls the API, a wallet or a signer. Delivery is not
// trusted from the recording: replay re-checks both commitments and re-decrypts the envelope offline.
import type { Hex } from "viem";
import { verifyAndDecrypt } from "./chain";
import { store, type DemoState } from "./store";
import { stopLive } from "./live";

export const RECORDING_VERSION = 1;

type Snapshot = Pick<DemoState, "jobId" | "draftRequest" | "draft" | "drafting" | "job" | "quotes" | "fundingTerms" | "fundOp" | "refundOp" | "events" | "submission">;

export interface Recording {
  version: number;
  runId: string;
  capturedAt: string;
  network: "arc-testnet";
  /** Real elapsed time of the run, ms. Playback may be faster, and says so. */
  durationMs: number;
  frames: { t: number; state: Snapshot }[];
  /** Captured once the delivery was decrypted live; re-verified offline on replay. */
  delivery?: { envelopeHex: string; contextHex: string };
}

const KEYS: (keyof Snapshot)[] = ["jobId", "draftRequest", "draft", "drafting", "job", "quotes", "fundingTerms", "fundOp", "refundOp", "events", "submission"];
const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));

let recording: Recording | null = null;
let t0 = 0;
let unsub: (() => void) | null = null;

export function startRecording() {
  stopRecording();
  t0 = performance.now();
  recording = { version: RECORDING_VERSION, runId: crypto.randomUUID(), capturedAt: new Date().toISOString(), network: "arc-testnet", durationMs: 0, frames: [] };
  let last = "";
  unsub = store.subscribe(() => {
    const s = store.get();
    if (!recording || s.mode !== "live") return;
    const snap = Object.fromEntries(KEYS.map((k) => [k, s[k]])) as Snapshot;
    const json = JSON.stringify(snap);
    if (json !== last) {
      last = json;
      recording.frames.push({ t: Math.round(performance.now() - t0), state: JSON.parse(json) as Snapshot });
    }
    if (s.delivery && !recording.delivery) recording.delivery = { envelopeHex: hex(s.delivery.envelope), contextHex: hex(s.delivery.context) };
  });
}

export function stopRecording(): Recording | null {
  unsub?.();
  unsub = null;
  if (recording) recording.durationMs = Math.round(performance.now() - t0);
  const r = recording;
  recording = null;
  return r;
}

export const isRecording = () => recording !== null;

export function downloadRecording(r: Recording) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(r)], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href: url, download: `ubc26-run-${r.capturedAt.replace(/[:.]/g, "-")}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let timers: ReturnType<typeof setTimeout>[] = [];

/** Plays a recording. `speed` > 1 compresses waits (the UI shows the real duration alongside). */
export function playRecording(r: Recording, speed = 1) {
  if (r.version !== RECORDING_VERSION) throw new Error(`Unsupported recording version ${r.version}`);
  stopLive();
  stopReplay();
  store.reset({ mode: "replay", recordedAt: r.capturedAt });
  for (const f of r.frames) {
    timers.push(setTimeout(() => store.set({ ...f.state, mode: "replay" }), f.t / speed));
  }
  const last = r.frames.at(-1);
  const sub = last?.state.submission;
  if (r.delivery && sub?.key && sub.envelopeHash && sub.keyCommitment) {
    const delivery = verifyAndDecrypt(unhex(r.delivery.envelopeHex), unhex(r.delivery.contextHex), sub.key as Hex, { envelopeHash: sub.envelopeHash, keyCommitment: sub.keyCommitment });
    timers.push(setTimeout(() => store.set({ delivery }), (last!.t + 400) / speed));
  }
}

export function stopReplay() {
  timers.forEach(clearTimeout);
  timers = [];
}
