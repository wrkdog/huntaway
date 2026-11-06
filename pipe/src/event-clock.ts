/**
 * The event clock (READ-CONTRACT-01 step 2): counts a CLI's events and has the count written at once on the first event,
 * then at most every `everyMs`, and on `end()`, so a card can tell a live CLI from a silent one. The interval is measured
 * on a monotonic clock, so a step of the wall clock never stops the writes; the store stamps each write with the pipe's
 * own clock. A write that throws never throws out; the next write, or `end()`, carries the newer count. After `end()`,
 * events are ignored.
 */
export function eventClock(write: (count: number) => void, now: () => number = () => performance.now(), everyMs = 15_000): { event(): void; end(): void } {
  let count = 0, written = 0, writtenMs = -Infinity, closed = false;
  const flush = (ms: number): void => {
    writtenMs = ms;
    try { write(count); written = count; } catch { /* the next write carries the newer count */ }
  };
  return {
    event: () => { if (closed) return; const ms = now(); count += 1; if (count === 1 || ms - writtenMs >= everyMs) flush(ms); },
    end: () => { if (!closed && count > written) flush(now()); closed = true; },
  };
}
