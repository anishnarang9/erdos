// Presenter keys. Space narrates and never authorises a payment. R/Shift+R replay, D act two, M mute,
// F fullscreen, S start/stop recording. Keys are ignored while typing in a field.
import { useEffect } from "react";
import { CAPTIONS } from "../components/Captions";
import { hostedDemo } from "./hosted";
import { startLive } from "./live";
import { downloadRecording, isRecording, playRecording, startRecording, stopRecording, type Recording } from "./replay";
import { stageOf, store } from "./store";

const ACT2_KEY = "ubc26.act2Job";

export function act2JobId(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("act2");
  if (fromUrl) {
    try {
      localStorage.setItem(ACT2_KEY, fromUrl);
    } catch {
      // storage unavailable
    }
    return fromUrl;
  }
  try {
    return localStorage.getItem(ACT2_KEY);
  } catch {
    return null;
  }
}

async function pickRecording(): Promise<Recording | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "application/json" });
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? (JSON.parse(await f.text()) as Recording) : null);
    };
    input.click();
  });
}

export function usePresenterKeys(onToast: (msg: string) => void) {
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const s = store.get();
      switch (e.key) {
        case " ": {
          e.preventDefault();
          const lines = CAPTIONS[stageOf(s)] ?? [];
          store.set({ captionIndex: lines.length ? (s.captionIndex + 1) % lines.length : 0 });
          break;
        }
        case "m":
        case "M":
          store.set({ muted: !s.muted });
          onToast(s.muted ? "Sound on" : "Muted");
          break;
        case "f":
        case "F":
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen();
          break;
        case "d":
        case "D": {
          if (hostedDemo) break;
          const id = act2JobId();
          if (!id) return onToast("No act-two job set: open the page with ?act2=<jobId>");
          store.reset({ focus: "act2" });
          startLive(id);
          onToast("Act two · tampered delivery");
          break;
        }
        case "r":
        case "R": {
          if (hostedDemo) break;
          const r = await pickRecording();
          if (r) {
            playRecording(r, e.shiftKey ? 4 : 1);
            onToast(e.shiftKey ? "Replaying at 4× (time-lapse)" : "Replaying recorded run");
          }
          break;
        }
        case "s":
        case "S":
          if (hostedDemo) break;
          if (isRecording()) {
            const r = stopRecording();
            if (r) downloadRecording(r);
            onToast("Recording saved");
          } else {
            startRecording();
            onToast("Recording this run");
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToast]);
}
