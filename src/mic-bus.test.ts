import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMicBus, type MicBusWarning } from "./mic-bus.js";

/** An audio track that only records whether it was stopped. */
function makeTrack(): MediaStreamTrack & { stopped: boolean } {
  const track = {
    stop: (): void => {
      track.stopped = true;
    },
    stopped: false,
  };
  return track as unknown as MediaStreamTrack & { stopped: boolean };
}

function makeStream(): MediaStream & { tracks: ReturnType<typeof makeTrack>[] } {
  const tracks = [makeTrack()];
  return {
    getTracks: () => tracks,
    tracks,
  } as unknown as MediaStream & { tracks: ReturnType<typeof makeTrack>[] };
}

type FakeContext = {
  closed: boolean;
  createGain: () => unknown;
  createMediaStreamSource: () => unknown;
  createScriptProcessor: (size: number) => FakeProcessor;
  resumed: number;
  state: string;
  processors: FakeProcessor[];
};

type FakeProcessor = {
  connect: () => void;
  disconnect: () => void;
  frameSize: number;
  onaudioprocess: ((event: unknown) => void) | null;
  /** Pretend one frame arrived from the microphone. */
  emit: (samples: Float32Array, sampleRate: number) => void;
};

function makeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  const processors: FakeProcessor[] = [];
  const context: FakeContext = {
    closed: false,
    createGain: () => ({
      connect: () => {},
      disconnect: () => {},
      gain: { value: 1 },
    }),
    createMediaStreamSource: () => ({
      connect: () => {},
      disconnect: () => {},
    }),
    createScriptProcessor: (size: number): FakeProcessor => {
      const processor: FakeProcessor = {
        connect: () => {},
        disconnect: () => {},
        emit: (samples, sampleRate) => {
          processor.onaudioprocess?.({
            inputBuffer: { getChannelData: () => samples, sampleRate },
          });
        },
        frameSize: size,
        onaudioprocess: null,
      };
      processors.push(processor);
      return processor;
    },
    processors,
    resumed: 0,
    state: "running",
    ...overrides,
  };
  Object.assign(context, {
    close: () => {
      context.closed = true;
      return Promise.resolve();
    },
    destination: {},
    resume: () => {
      context.resumed += 1;
      context.state = "running";
      return Promise.resolve();
    },
  });
  return context;
}

type Harness = ReturnType<typeof setup>;

function setup(
  options: {
    contextOverrides?: Partial<FakeContext>;
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  } = {},
) {
  const contexts: FakeContext[] = [];
  const streams: ReturnType<typeof makeStream>[] = [];
  const warnings: MicBusWarning[] = [];
  const calls: MediaStreamConstraints[] = [];

  const getUserMedia =
    options.getUserMedia ??
    ((constraints: MediaStreamConstraints): Promise<MediaStream> => {
      calls.push(constraints);
      const stream = makeStream();
      streams.push(stream);
      return Promise.resolve(stream);
    });

  const bus = createMicBus({
    audioContext: () => {
      const context = makeContext(options.contextOverrides);
      contexts.push(context);
      return context as unknown as AudioContext;
    },
    getUserMedia: (constraints) => {
      if (options.getUserMedia) calls.push(constraints);
      return getUserMedia(constraints);
    },
    onWarning: (warning) => warnings.push(warning),
  });

  return { bus, calls, contexts, streams, warnings };
}

function processorOf(harness: Harness, index = 0): FakeProcessor {
  const processor = harness.contexts[index]?.processors[0];
  if (!processor) throw new Error("no processor was created");
  return processor;
}

describe("open", () => {
  it("opens the default microphone", async () => {
    const harness = setup();
    await harness.bus.open();
    expect(harness.calls).toEqual([{ audio: true }]);
    expect(harness.bus.isOpen).toBe(true);
  });

  it("opens a named device", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    expect(harness.calls).toEqual([
      { audio: { deviceId: { exact: "mic-1" } } },
    ]);
    expect(harness.bus.deviceId).toBe("mic-1");
  });

  it("does not reopen the same device", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    await harness.bus.open("mic-1");
    // Reopening loses every sample spoken during the gap.
    expect(harness.calls).toHaveLength(1);
  });

  it("reopens on a device change and stops the previous one", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    await harness.bus.open("mic-2");
    expect(harness.calls).toHaveLength(2);
    expect(harness.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(harness.contexts[0]?.closed).toBe(true);
    expect(harness.bus.deviceId).toBe("mic-2");
  });

  it("collapses concurrent opens into one", async () => {
    const harness = setup();
    // Letting them through opens a second device.
    await Promise.all([harness.bus.open("mic-1"), harness.bus.open("mic-1")]);
    expect(harness.calls).toHaveLength(1);
  });

  it("resumes a context that starts suspended", async () => {
    // On Android Chrome the context starts suspended when a getUserMedia await
    // comes first. Without a resume, not a single frame arrives.
    const harness = setup({ contextOverrides: { state: "suspended" } });
    await harness.bus.open();
    expect(harness.contexts[0]?.resumed).toBe(1);
  });
});

describe("failures", () => {
  it("retries once, and only for failures worth retrying", async () => {
    vi.useFakeTimers();
    try {
      const error = Object.assign(new Error("busy"), {
        name: "NotReadableError",
      });
      const getUserMedia = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue(makeStream());
      const harness = setup({ getUserMedia });

      const opening = harness.bus.open();
      await vi.advanceTimersByTimeAsync(250);
      await opening;
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a permission failure", async () => {
    const error = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    const getUserMedia = vi.fn().mockRejectedValue(error);
    const harness = setup({ getUserMedia });

    await expect(harness.bus.open()).rejects.toThrow("denied");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default device when the named one fails", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("gone"), { name: "OverconstrainedError" }),
      )
      .mockResolvedValue(makeStream());
    const harness = setup({ getUserMedia });

    await harness.bus.open("mic-gone");
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
    expect(harness.warnings[0]).toMatchObject({
      deviceId: "mic-gone",
      type: "device-fallback",
    });
  });

  it("releases the acquired microphone when wiring fails", async () => {
    // Without this, an open device nobody receives from is stranded, and the
    // next open cannot acquire one.
    const stream = makeStream();
    const harness = setup({
      contextOverrides: {
        createMediaStreamSource: () => {
          throw new Error("attach failed");
        },
      },
      getUserMedia: () => Promise.resolve(stream),
    });

    await expect(harness.bus.open()).rejects.toThrow("attach failed");
    expect(stream.tracks[0]?.stopped).toBe(true);
    expect(harness.bus.isOpen).toBe(false);
  });
});

describe("subscribe", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = setup();
    await harness.bus.open();
  });

  it("delivers incoming frames", () => {
    const first = vi.fn();
    const second = vi.fn();
    harness.bus.subscribe(first);
    harness.bus.subscribe(second);

    const samples = new Float32Array([0.1, 0.2]);
    processorOf(harness).emit(samples, 48000);

    expect(first).toHaveBeenCalledWith(samples, 48000);
    expect(second).toHaveBeenCalledWith(samples, 48000);
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = harness.bus.subscribe(listener);
    unsubscribe();
    processorOf(harness).emit(new Float32Array(1), 48000);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps delivering to the others when one listener throws", () => {
    const failing = vi.fn(() => {
      throw new Error("listener boom");
    });
    const healthy = vi.fn();
    harness.bus.subscribe(failing);
    harness.bus.subscribe(healthy);

    processorOf(harness).emit(new Float32Array(1), 48000);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(harness.warnings).toContainEqual(
      expect.objectContaining({ type: "listener-failed" }),
    );
  });

  it("keeps listeners across a close and resumes on reopen", async () => {
    const listener = vi.fn();
    harness.bus.subscribe(listener);
    harness.bus.close();
    expect(harness.bus.isOpen).toBe(false);
    expect(harness.bus.listenerCount).toBe(1);

    await harness.bus.open();
    processorOf(harness, 1).emit(new Float32Array(1), 48000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("close", () => {
  it("releases the microphone and the AudioContext", async () => {
    const harness = setup();
    await harness.bus.open();
    harness.bus.close();

    expect(harness.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(harness.contexts[0]?.closed).toBe(true);
    expect(harness.bus.isOpen).toBe(false);
    expect(harness.bus.deviceId).toBeNull();
  });

  it("does not throw when nothing is open", () => {
    const harness = setup();
    expect(() => harness.bus.close()).not.toThrow();
  });
});

describe("output sink", () => {
  it("silences the sink where supported", async () => {
    // Opening hardware output while Bluetooth is connected stops frames from
    // arriving on some Android devices.
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const harness = setup({ contextOverrides: { setSinkId } as never });
    await harness.bus.open();
    expect(setSinkId).toHaveBeenCalledWith({ type: "none" });
  });

  it("still opens when the sink cannot be silenced", async () => {
    // iOS Safari has no setSinkId.
    const setSinkId = vi.fn().mockRejectedValue(new Error("unsupported"));
    const harness = setup({ contextOverrides: { setSinkId } as never });
    await harness.bus.open();

    expect(harness.bus.isOpen).toBe(true);
    expect(harness.warnings).toContainEqual(
      expect.objectContaining({ type: "sink-not-silenced" }),
    );
  });
});
