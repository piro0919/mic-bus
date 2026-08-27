/**
 * Open the microphone once and share its audio frames with every consumer.
 *
 * When two or more things need the same audio — wake word detection and
 * transcription, say — having each of them call `getUserMedia` means the device
 * is reopened every time you switch between them. Reopening takes hundreds of
 * milliseconds on some hardware, and whatever is said during that window is lost
 * entirely. Wake word matching falls below its threshold when the start of an
 * utterance is clipped, so this shows up as the wake word simply not firing
 * rather than as a delay.
 */

/** Receives audio frames. `samples` is single-channel Float32 in the -1..1 range. */
export type MicFrameListener = (
  samples: Float32Array,
  sampleRate: number,
) => void;

/**
 * Failures worth one retry.
 *
 * "Something else is using it right now" often clears on its own. Missing
 * permission, missing API and missing hardware give the same answer however many
 * times you ask, so those are passed straight through.
 */
const RETRIABLE_ERRORS = new Set([
  "AbortError",
  "InvalidStateError",
  "NotReadableError",
  "TrackStartError",
]);

/** ScriptProcessor granularity. At 48 kHz one frame arrives roughly every 85 ms. */
const DEFAULT_FRAME_SIZE = 4096;
const RETRY_DELAY_MS = 250;

export type MicBusWarning =
  /** The requested device could not be opened, so the default one is in use. */
  | { deviceId: string; error: unknown; type: "device-fallback" }
  /** A listener threw. Delivery to the others continued. */
  | { error: unknown; type: "listener-failed" }
  /** The output sink could not be silenced. Playback still works on most devices. */
  | { error: unknown; type: "sink-not-silenced" };

export type MicBusOptions = {
  /** Creates the `AudioContext`. Defaults to the global one, falling back to `webkitAudioContext`. */
  audioContext?: () => AudioContext;
  /** Samples per frame. A power of two. Defaults to 4096. */
  frameSize?: number;
  /** Replaces `navigator.mediaDevices.getUserMedia`. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Events that do not stop the bus but are worth surfacing, e.g. as a toast. */
  onWarning?: (warning: MicBusWarning) => void;
};

export type MicBus = {
  /** The open device, or null for the default one. Also null while closed. */
  readonly deviceId: null | string;
  /** Whether the microphone is currently open. */
  readonly isOpen: boolean;
  /** How many listeners are attached. */
  readonly listenerCount: number;
  /** Close the microphone. Listeners stay attached and resume on the next open. */
  close: () => void;
  /**
   * Open the microphone. Does nothing if the same device is already open.
   * Reopens when the requested device changed.
   */
  open: (deviceId?: null | string) => Promise<void>;
  /** Start receiving audio frames. Call the returned function to stop. */
  subscribe: (listener: MicFrameListener) => () => void;
};

type State = {
  audioContext: AudioContext | null;
  deviceId: null | string;
  processor: null | ScriptProcessorNode;
  silentGain: GainNode | null;
  source: MediaStreamAudioSourceNode | null;
  stream: MediaStream | null;
};

type WindowWithWebkit = {
  webkitAudioContext?: typeof AudioContext;
} & Window;

function defaultAudioContext(): AudioContext {
  const impl =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ?? (window as WindowWithWebkit).webkitAudioContext);
  if (!impl) {
    throw new Error("AudioContext is not supported in this environment");
  }
  return new impl();
}

function defaultGetUserMedia(
  constraints: MediaStreamConstraints,
): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return Promise.reject(
      new Error("navigator.mediaDevices is not available in this environment"),
    );
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Create a microphone bus.
 *
 * One is usually enough, so reach for the exported `micBus` first. Create your own
 * for tests, or when you genuinely need to drive several devices at once.
 */
export function createMicBus(options: MicBusOptions = {}): MicBus {
  const frameSize = options.frameSize ?? DEFAULT_FRAME_SIZE;
  const getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
  const makeAudioContext = options.audioContext ?? defaultAudioContext;
  const listeners = new Set<MicFrameListener>();
  const state: State = {
    audioContext: null,
    deviceId: null,
    processor: null,
    silentGain: null,
    source: null,
    stream: null,
  };
  // Collapse concurrent opens into one. Letting them through opens a second device.
  let openInFlight: null | Promise<void> = null;

  function warn(warning: MicBusWarning): void {
    options.onWarning?.(warning);
  }

  async function acquire(
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream> {
    try {
      return await getUserMedia(constraints);
    } catch (error) {
      const name =
        error && typeof error === "object" && "name" in error
          ? String((error as { name: unknown }).name)
          : "";
      if (!RETRIABLE_ERRORS.has(name)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return getUserMedia(constraints);
    }
  }

  async function getStream(deviceId: null | string): Promise<MediaStream> {
    if (!deviceId) return acquire({ audio: true });
    try {
      return await acquire({ audio: { deviceId: { exact: deviceId } } });
    } catch (error) {
      // The chosen microphone may have been unplugged. Fall back and keep going.
      warn({ deviceId, error, type: "device-fallback" });
      return acquire({ audio: true });
    }
  }

  function teardown(): void {
    if (state.processor) {
      state.processor.onaudioprocess = null;
      state.processor.disconnect();
      state.processor = null;
    }
    if (state.silentGain) {
      state.silentGain.disconnect();
      state.silentGain = null;
    }
    if (state.source) {
      state.source.disconnect();
      state.source = null;
    }
    if (state.stream) {
      for (const track of state.stream.getTracks()) track.stop();
      state.stream = null;
    }
    if (state.audioContext) {
      if (state.audioContext.state !== "closed") {
        void state.audioContext.close().catch(() => {});
      }
      state.audioContext = null;
    }
    state.deviceId = null;
  }

  async function attach(
    stream: MediaStream,
    deviceId: null | string,
  ): Promise<void> {
    const audioContext = makeAudioContext();

    // Recording needs no speaker output. While Bluetooth is connected the
    // AudioContext routes its output to the headset, and some Android devices
    // cannot establish full-duplex SCO alongside the microphone input. When that
    // happens the render thread stalls and onaudioprocess stops firing entirely.
    // A silent sink avoids opening hardware output at all. iOS Safari has no
    // setSinkId, so only call it where it exists.
    const withSink = audioContext as {
      setSinkId?: (sinkId: string | { type: "none" }) => Promise<void>;
    } & AudioContext;
    if (typeof withSink.setSinkId === "function") {
      try {
        await withSink.setSinkId({ type: "none" });
      } catch (error) {
        warn({ error, type: "sink-not-silenced" });
      }
    }

    // On Android Chrome the context starts suspended when a getUserMedia await
    // comes first. Without a resume, onaudioprocess never fires. Resuming an
    // already-running context is a no-op.
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(frameSize, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event): void => {
      const input = event.inputBuffer.getChannelData(0);
      const sampleRate = event.inputBuffer.sampleRate;
      // One listener throwing must not stop delivery to the others.
      for (const listener of [...listeners]) {
        try {
          listener(input, sampleRate);
        } catch (error) {
          warn({ error, type: "listener-failed" });
        }
      }
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    state.audioContext = audioContext;
    state.deviceId = deviceId;
    state.processor = processor;
    state.silentGain = silentGain;
    state.source = source;
    state.stream = stream;
  }

  async function openOnce(deviceId: null | string): Promise<void> {
    const stream = await getStream(deviceId);
    try {
      await attach(stream, deviceId);
    } catch (error) {
      // Failing here leaves the acquired microphone out of reach of teardown(),
      // because it is not in state yet. That would strand an open device nobody
      // receives from, and the next open would fail to acquire one. Release what
      // we took.
      for (const track of stream.getTracks()) track.stop();
      throw error;
    }
  }

  return {
    close(): void {
      teardown();
    },
    get deviceId(): null | string {
      return state.deviceId;
    },
    get isOpen(): boolean {
      return state.stream !== null;
    },
    get listenerCount(): number {
      return listeners.size;
    },
    async open(deviceId: null | string = null): Promise<void> {
      if (openInFlight) {
        await openInFlight;
        if (state.stream && state.deviceId === deviceId) return;
      }
      if (state.stream && state.deviceId === deviceId) return;

      openInFlight = (async (): Promise<void> => {
        if (state.stream) teardown();
        try {
          await openOnce(deviceId);
        } catch (error) {
          teardown();
          throw error;
        }
      })().finally(() => {
        openInFlight = null;
      });

      await openInFlight;
    },
    subscribe(listener: MicFrameListener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}
