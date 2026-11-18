/** Each subsystem owns its claims and drain guard. This timer only supplies ticks. */
export function startPumpTimer(pump: () => Promise<void>, onError: (error: unknown) => void) {
  return setInterval(() => {
    void pump().catch(onError);
  }, 1000);
}
