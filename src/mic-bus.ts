/**
 * マイクを1本だけ開き、音声フレームを複数の受け取り手へ配る。
 *
 * 待ち受け（ウェイクワード検知）と文字起こしのように、同じ音を必要とするものが
 * 2つ以上あるとき、それぞれが `getUserMedia` を呼ぶと、切り替えのたびにデバイスを
 * 開き直すことになる。開き直しは端末によっては数百ミリ秒かかり、その間の発話は
 * 丸ごと落ちる。待ち受けの照合は発話の先頭が少し欠けるだけで閾値を割るので、
 * これは「遅れ」ではなく「不発」として現れる。
 */

/** 音声フレームの受け取り手。`samples` は 1ch の Float32（-1〜1）。 */
export type MicFrameListener = (
  samples: Float32Array,
  sampleRate: number,
) => void;

/**
 * 少し置いて取り直す価値のある失敗。
 *
 * 「今はほかが使っている」たぐいはすぐ解けることがある。権限が無い・API が無い・
 * 端末が無いは何度試しても同じなので、そのまま返す。
 */
const RETRIABLE_ERRORS = new Set([
  "AbortError",
  "InvalidStateError",
  "NotReadableError",
  "TrackStartError",
]);

/** ScriptProcessor の粒度。48 kHz なら約 85 ミリ秒ごとに 1 フレーム届く。 */
const DEFAULT_FRAME_SIZE = 4096;
const RETRY_DELAY_MS = 250;

export type MicBusWarning =
  /** 指定されたデバイスを開けず、既定のマイクに切り替えた。 */
  | { deviceId: string; error: unknown; type: "device-fallback" }
  /** 受け取り手が投げた。ほかへの配布は続けている。 */
  | { error: unknown; type: "listener-failed" }
  /** 出力先を切れなかった。動きはするが、一部の端末で音が止まることがある。 */
  | { error: unknown; type: "sink-not-silenced" };

export type MicBusOptions = {
  /** `AudioContext` を作る。既定はグローバルのもの（`webkitAudioContext` も見る）。 */
  audioContext?: () => AudioContext;
  /** 1 フレームのサンプル数。2 の冪。既定 4096。 */
  frameSize?: number;
  /** `navigator.mediaDevices.getUserMedia` の差し替え。 */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** 続行はできるが伝えたい出来事。トーストなどに繋ぐ。 */
  onWarning?: (warning: MicBusWarning) => void;
};

export type MicBus = {
  /** 開いているデバイス。既定のマイクなら null。閉じていても null。 */
  readonly deviceId: null | string;
  /** 今開いているか。 */
  readonly isOpen: boolean;
  /** 受け取り手の数。 */
  readonly listenerCount: number;
  /** マイクを閉じる。購読は残るので、次に開けばそのまま届く。 */
  close: () => void;
  /**
   * マイクを開く。すでに同じデバイスで開いていれば何もしない。
   * デバイスの指定が変わっていたら開き直す。
   */
  open: (deviceId?: null | string) => Promise<void>;
  /** 音声フレームの受け取りを始める。戻り値を呼ぶと止まる。 */
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
 * マイクの共有を作る。
 *
 * 普通は1本あれば足りるので、`micBus` をそのまま使ってよい。
 * 試験や、複数の端末を同時に扱う場合にここから作る。
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
  // 同時に開こうとしたぶんを1本にまとめる。素通しすると2本目のデバイスが開く。
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
      // 選んだマイクが抜かれていることがある。既定に落として鳴らし続ける。
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

    // 録音するだけで出力（スピーカー）は要らない。Bluetooth 接続中は AudioContext の
    // 出力先が BT（SCO 再生）になり、BT マイク入力（SCO 録音）との全二重 SCO を
    // 一部の Android 端末が確立できず、レンダースレッドが止まって onaudioprocess が
    // 発火しなくなる。ハードウェア出力を開かない silent sink にして避ける。
    // iOS Safari は setSinkId に対応しないので、あるときだけ呼ぶ。
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

    // getUserMedia の await を挟むと Android Chrome では suspended で始まる。
    // resume しないと onaudioprocess が発火しない。running への resume は何もしない。
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
      // 受け取り手の1つが投げても、ほかへの配布は止めない。
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
      // ここで転ぶと、掴んだマイクはまだ state に載っていないので teardown() の
      // 手が届かない。誰にも配られないまま開きっぱなしのデバイスが残り、次に
      // 開こうとしたものが取れなくなる。取ったものは自分で手放す。
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
