/** Timers behind a small interface, so tests drive time themselves and nothing leaks. */

export type TimerHandle = { readonly id: number };

export type Timers = {
  set(run: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
};

let counter = 0;

/** The real clock. */
export function realTimers(): Timers {
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    set(run, ms) {
      const id = ++counter;
      live.set(
        id,
        setTimeout(() => {
          live.delete(id);
          run();
        }, ms),
      );
      return { id };
    },
    clear(handle) {
      const timer = live.get(handle.id);
      if (timer !== undefined) clearTimeout(timer);
      live.delete(handle.id);
    },
  };
}
