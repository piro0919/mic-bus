import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMicBus, type MicBusWarning } from "./mic-bus.js";

/** 停めたことが分かるだけの音声トラック。 */
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
  /** マイクから 1 フレーム届いたことにする。 */
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
  it("既定のマイクを開く", async () => {
    const harness = setup();
    await harness.bus.open();
    expect(harness.calls).toEqual([{ audio: true }]);
    expect(harness.bus.isOpen).toBe(true);
  });

  it("デバイスを指定して開く", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    expect(harness.calls).toEqual([
      { audio: { deviceId: { exact: "mic-1" } } },
    ]);
    expect(harness.bus.deviceId).toBe("mic-1");
  });

  it("同じデバイスなら開き直さない", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    await harness.bus.open("mic-1");
    // 開き直すと、その間の音声が丸ごと落ちる。
    expect(harness.calls).toHaveLength(1);
  });

  it("デバイスが変わったら開き直し、前のものを止める", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    await harness.bus.open("mic-2");
    expect(harness.calls).toHaveLength(2);
    expect(harness.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(harness.contexts[0]?.closed).toBe(true);
    expect(harness.bus.deviceId).toBe("mic-2");
  });

  it("同時に開こうとしても1本にまとめる", async () => {
    const harness = setup();
    // 素通しすると 2 本目のデバイスが開く。
    await Promise.all([harness.bus.open("mic-1"), harness.bus.open("mic-1")]);
    expect(harness.calls).toHaveLength(1);
  });

  it("suspended で始まったら resume する", async () => {
    // Android Chrome では getUserMedia の await を挟むと suspended で始まる。
    // resume しないとフレームが1つも届かない。
    const harness = setup({ contextOverrides: { state: "suspended" } });
    await harness.bus.open();
    expect(harness.contexts[0]?.resumed).toBe(1);
  });
});

describe("失敗したとき", () => {
  it("取り直す価値のある失敗だけ 1 回やり直す", async () => {
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

  it("権限の失敗はやり直さない", async () => {
    const error = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    const getUserMedia = vi.fn().mockRejectedValue(error);
    const harness = setup({ getUserMedia });

    await expect(harness.bus.open()).rejects.toThrow("denied");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("指定のデバイスが開けなければ既定へ落とす", async () => {
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

  it("組み立てに失敗したら掴んだマイクを手放す", async () => {
    // ここで手放さないと、誰にも配られないまま開きっぱなしのデバイスが残り、
    // 次に開こうとしたものが取れなくなる。
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

  it("届いたフレームを配る", () => {
    const first = vi.fn();
    const second = vi.fn();
    harness.bus.subscribe(first);
    harness.bus.subscribe(second);

    const samples = new Float32Array([0.1, 0.2]);
    processorOf(harness).emit(samples, 48000);

    expect(first).toHaveBeenCalledWith(samples, 48000);
    expect(second).toHaveBeenCalledWith(samples, 48000);
  });

  it("止めたら届かなくなる", () => {
    const listener = vi.fn();
    const unsubscribe = harness.bus.subscribe(listener);
    unsubscribe();
    processorOf(harness).emit(new Float32Array(1), 48000);
    expect(listener).not.toHaveBeenCalled();
  });

  it("1 つが投げても、ほかへの配布を止めない", () => {
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

  it("閉じても購読は残り、開き直せば届く", async () => {
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
  it("マイクと AudioContext を手放す", async () => {
    const harness = setup();
    await harness.bus.open();
    harness.bus.close();

    expect(harness.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(harness.contexts[0]?.closed).toBe(true);
    expect(harness.bus.isOpen).toBe(false);
    expect(harness.bus.deviceId).toBeNull();
  });

  it("開いていなくても投げない", () => {
    const harness = setup();
    expect(() => harness.bus.close()).not.toThrow();
  });
});

describe("出力先", () => {
  it("対応していれば無音の出力先にする", async () => {
    // Bluetooth 接続中に出力を開くと、一部の Android 端末でフレームが
    // 届かなくなる。
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const harness = setup({ contextOverrides: { setSinkId } as never });
    await harness.bus.open();
    expect(setSinkId).toHaveBeenCalledWith({ type: "none" });
  });

  it("切れなくても開くのは続ける", async () => {
    // iOS Safari は setSinkId に対応しない。
    const setSinkId = vi.fn().mockRejectedValue(new Error("unsupported"));
    const harness = setup({ contextOverrides: { setSinkId } as never });
    await harness.bus.open();

    expect(harness.bus.isOpen).toBe(true);
    expect(harness.warnings).toContainEqual(
      expect.objectContaining({ type: "sink-not-silenced" }),
    );
  });
});
