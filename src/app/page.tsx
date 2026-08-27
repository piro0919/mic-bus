"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createMicBus, type MicBusWarning } from "../index";

/** One consumer of the shared microphone, as shown on the page. */
type Consumer = {
  color: string;
  description: string;
  id: string;
  name: string;
};

const CONSUMERS: Consumer[] = [
  {
    color: "sky",
    description: "Draws the waveform of every frame it receives.",
    id: "waveform",
    name: "Waveform",
  },
  {
    color: "emerald",
    description: "Tracks the loudest sample seen so far.",
    id: "level",
    name: "Level meter",
  },
  {
    color: "violet",
    description: "Counts frames and samples, nothing else.",
    id: "counter",
    name: "Frame counter",
  },
];

type ConsumerState = {
  frames: number;
  level: number;
  peak: number;
  samples: number;
  waveform: number[];
};

const EMPTY: ConsumerState = {
  frames: 0,
  level: 0,
  peak: 0,
  samples: 0,
  waveform: [],
};

const WAVEFORM_BARS = 48;

/* Stable keys for the fixed set of bars. The bars are positions, not data. */
const BAR_IDS = Array.from({ length: WAVEFORM_BARS }, (_, i) => `bar-${i}`);

/** Reduce one frame to the handful of numbers the page displays. */
function summarize(previous: ConsumerState, samples: Float32Array) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
    sum += value;
  }
  const level = sum / Math.max(1, samples.length);
  return {
    frames: previous.frames + 1,
    level,
    peak: Math.max(previous.peak, peak),
    samples: previous.samples + samples.length,
    waveform: [...previous.waveform, peak].slice(-WAVEFORM_BARS),
  };
}

/* The exported `micBus` with a warning handler attached, so the events the bus
   keeps running through are visible here instead of silent. */
const bus = createMicBus({
  onWarning: (warning) => {
    warningSink?.(warning);
  },
});

let warningSink: ((warning: MicBusWarning) => void) | null = null;

export default function Home() {
  const [attached, setAttached] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<null | string>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [sampleRate, setSampleRate] = useState<null | number>(null);
  const [states, setStates] = useState<Record<string, ConsumerState>>({});
  const [warnings, setWarnings] = useState<
    { id: number; warning: MicBusWarning }[]
  >([]);
  const unsubscribes = useRef<Record<string, () => void>>({});

  // Release the device when the page goes away. Nothing else here closes it,
  // which is the point: recordings start and stop without touching the mic.
  useEffect(() => {
    return () => {
      for (const off of Object.values(unsubscribes.current)) off();
      bus.close();
    };
  }, []);

  const open = useCallback(async () => {
    setError(null);
    setOpening(true);
    try {
      await bus.open();
      setIsOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  }, []);

  const close = useCallback(() => {
    bus.close();
    setIsOpen(false);
  }, []);

  const toggle = useCallback((consumer: Consumer) => {
    setAttached((previous) => {
      const next = !previous[consumer.id];
      if (next) {
        setStates((s) => ({ ...s, [consumer.id]: EMPTY }));
        unsubscribes.current[consumer.id] = bus.subscribe((samples, rate) => {
          setSampleRate(rate);
          setStates((s) => ({
            ...s,
            [consumer.id]: summarize(s[consumer.id] ?? EMPTY, samples),
          }));
        });
      } else {
        unsubscribes.current[consumer.id]?.();
        delete unsubscribes.current[consumer.id];
      }
      return { ...previous, [consumer.id]: next };
    });
  }, []);

  useEffect(() => {
    let nextId = 0;
    warningSink = (warning) =>
      setWarnings((previous) => [...previous, { id: nextId++, warning }]);
    return () => {
      warningSink = null;
    };
  }, []);

  const listenerCount = Object.values(attached).filter(Boolean).length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 text-center">
          <h1 className="mb-2 font-display text-4xl font-bold tracking-tight text-white">
            shared-microphone
          </h1>
          <p className="text-zinc-400">One microphone, many listeners</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3 text-sm">
            <a
              className="rounded-full bg-zinc-700/50 px-4 py-2 text-zinc-300 transition-colors hover:bg-zinc-700"
              href="https://www.npmjs.com/package/shared-microphone"
              rel="noreferrer"
              target="_blank"
            >
              npm
            </a>
            <a
              className="rounded-full bg-zinc-700/50 px-4 py-2 text-zinc-300 transition-colors hover:bg-zinc-700"
              href="https://github.com/piro0919/shared-microphone"
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </div>
        </header>

        <section className="mb-10 rounded-2xl border border-zinc-700/60 bg-zinc-900/60 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${
                    isOpen ? "bg-emerald-400" : "bg-zinc-600"
                  }`}
                />
                <span className="font-medium text-white">
                  {isOpen ? "Microphone open" : "Microphone closed"}
                </span>
              </div>
              <p className="mt-1 text-sm text-zinc-400">
                {listenerCount} listener{listenerCount === 1 ? "" : "s"}
                {sampleRate ? ` · ${sampleRate} Hz` : ""}
              </p>
            </div>
            <button
              className="rounded-full bg-sky-500 px-5 py-2.5 font-medium text-sky-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={opening}
              onClick={isOpen ? close : open}
              type="button"
            >
              {opening ? "Opening…" : isOpen ? "Close" : "Open microphone"}
            </button>
          </div>

          {error ? (
            <p className="mt-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </p>
          ) : null}

          <p className="mt-4 text-sm text-zinc-500">
            Attach and detach the listeners below while the microphone stays
            open. The device is never reopened, so nothing is lost in between.
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          {CONSUMERS.map((consumer) => {
            const state = states[consumer.id] ?? EMPTY;
            const on = Boolean(attached[consumer.id]);
            return (
              <div
                className={`rounded-2xl border p-5 transition-colors ${
                  on
                    ? "border-zinc-600 bg-zinc-800/70"
                    : "border-zinc-800 bg-zinc-900/40"
                }`}
                key={consumer.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium text-white">{consumer.name}</h2>
                    <p className="mt-1 text-xs text-zinc-500">
                      {consumer.description}
                    </p>
                  </div>
                  <button
                    aria-pressed={on}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      on
                        ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                        : "bg-zinc-700/50 text-zinc-300 hover:bg-zinc-700"
                    }`}
                    onClick={() => toggle(consumer)}
                    type="button"
                  >
                    {on ? "On" : "Off"}
                  </button>
                </div>

                <div className="mt-4 h-16">
                  {consumer.id === "waveform" ? (
                    <div className="flex h-full items-end gap-0.5">
                      {BAR_IDS.map((id, i) => {
                        const value = state.waveform[i] ?? 0;
                        return (
                          <div
                            className="flex-1 rounded-full bg-sky-400/80"
                            key={id}
                            style={{
                              height: `${Math.max(2, Math.min(100, value * 180))}%`,
                            }}
                          />
                        );
                      })}
                    </div>
                  ) : consumer.id === "level" ? (
                    <div className="flex h-full flex-col justify-end gap-2">
                      <div className="h-3 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-emerald-400 transition-[width] duration-75"
                          style={{
                            width: `${Math.min(100, state.level * 400)}%`,
                          }}
                        />
                      </div>
                      <p className="font-mono text-xs text-zinc-400">
                        peak {state.peak.toFixed(3)}
                      </p>
                    </div>
                  ) : (
                    <div className="flex h-full flex-col justify-end font-mono text-xs text-zinc-400">
                      <p>{state.frames} frames</p>
                      <p>{state.samples.toLocaleString("en-US")} samples</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {warnings.length > 0 ? (
          <ul className="mt-6 space-y-1 text-sm text-amber-300">
            {warnings.map(({ id, warning }) => (
              <li key={id}>{warning.type}</li>
            ))}
          </ul>
        ) : null}

        <section className="mt-14">
          <h2 className="mb-4 font-display text-xl font-bold text-white">
            Install
          </h2>
          <pre className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 font-mono text-sm text-zinc-300">
            <code>npm install shared-microphone</code>
          </pre>

          <h2 className="mt-10 mb-4 font-display text-xl font-bold text-white">
            Usage
          </h2>
          <pre className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 font-mono text-sm text-zinc-300">
            <code>{`import { micBus } from "shared-microphone";

// Subscribe before the microphone is open if you like.
const stop = micBus.subscribe((samples, sampleRate) => {
  recognizer.write(samples, sampleRate);
});

await micBus.open();  // null or a deviceId
stop();               // stop receiving; the device stays open
micBus.close();       // release the device`}</code>
          </pre>
        </section>

        <footer className="mt-16 text-center text-sm text-zinc-600">
          <a
            className="transition-colors hover:text-zinc-400"
            href="https://kkweb.io/"
            rel="noreferrer"
            target="_blank"
          >
            kkweb.io
          </a>
        </footer>
      </div>
    </div>
  );
}
