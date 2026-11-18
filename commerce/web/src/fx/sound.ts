// Subtle synthesized UI sounds (Web Audio, no files). Muted when the store says so.
import { store } from "../lib/store";

let ctx: AudioContext | null = null;
let hum: { osc: OscillatorNode; gain: GainNode } | null = null;

function ac(): AudioContext | null {
  if (store.get().muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, ms: number, type: OscillatorType = "sine", volume = 0.06, delay = 0) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(volume, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.05);
}

export const sound = {
  tick: () => tone(1800, 60, "square", 0.025),
  chime: () => {
    tone(880, 500, "sine", 0.07);
    tone(1320, 700, "sine", 0.05, 0.12);
  },
  clink: () => {
    tone(2400, 120, "triangle", 0.06);
    tone(3200, 180, "triangle", 0.04, 0.06);
  },
  buzz: () => tone(110, 450, "sawtooth", 0.05),
  humStart() {
    const a = ac();
    if (!a || hum) return;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = "sine";
    osc.frequency.value = 72;
    gain.gain.value = 0.02;
    osc.connect(gain).connect(a.destination);
    osc.start();
    hum = { osc, gain };
  },
  humStop() {
    if (!hum) return;
    hum.gain.gain.exponentialRampToValueAtTime(0.0001, (ctx?.currentTime ?? 0) + 0.3);
    hum.osc.stop((ctx?.currentTime ?? 0) + 0.35);
    hum = null;
  },
};
