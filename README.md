# mic-bus

マイクを1本だけ開き、音声フレームを必要なものすべてへ配る。

ウェイクワードの待ち受けと文字起こしのように、同じ音を要するものが2つ以上あるとき、それぞれが `getUserMedia` を呼ぶと切り替えのたびにデバイスを開き直すことになる。開き直しは端末によっては数百ミリ秒かかり、その間の発話は丸ごと落ちる。待ち受けの照合は発話の先頭が少し欠けるだけで閾値を割るので、これは「遅れ」ではなく「不発」として現れる。

- 依存パッケージなし
- デバイスは1本だけ開く。誰が何回開こうとしても、同じ指定なら開き直さない
- 受け取り手の1つが投げても、ほかへの配布は止まらない
- 現場で踏んだ端末ごとの癖に対処済み（下の「気をつけている点」）

## 導入

```bash
npm install mic-bus
```

## 使い方

```ts
import { micBus } from "mic-bus";

// 音の受け取りを始める。まだ開いていなくても登録できる
const stopListening = micBus.subscribe((samples, sampleRate) => {
  // samples は 1ch の Float32（-1〜1）
  recognizer.write(samples, sampleRate);
});

// マイクを開く。null なら既定のマイク
await micBus.open(selectedDeviceId);

// 受け取りだけ止める。マイクは開いたまま
stopListening();

// マイクを手放す。通話にマイクを譲るときや、画面が表から消えたとき
micBus.close();
```

`subscribe` と `open` は独立している。録音の開始や終了でデバイスを触らないので、待ち受けと文字起こしを行き来しても開き直しが起きない。

### 複数の受け取り手

```ts
micBus.subscribe(wakeWordDetector.write);
micBus.subscribe(transcriber.write);
await micBus.open();
// 1 本のデバイスから、両方へ同じフレームが届く
```

### 続行はできるが伝えたいこと

```ts
import { createMicBus } from "mic-bus";

const bus = createMicBus({
  onWarning: (warning) => {
    if (warning.type === "device-fallback") {
      toast.warning("選択中のマイクが使えないため、既定のマイクを使います");
    }
  },
});
```

| `type` | 意味 |
| ------ | ---- |
| `device-fallback` | 指定されたデバイスを開けず、既定のマイクに切り替えた |
| `listener-failed` | 受け取り手が投げた。ほかへの配布は続けている |
| `sink-not-silenced` | 出力先を切れなかった。動きはする |

## 設定

`createMicBus(options)` で作る。既定の共有マイク `micBus` は `createMicBus()` そのもの。

| 名前 | 既定 | 説明 |
| ---- | ---- | ---- |
| `frameSize` | `4096` | 1 フレームのサンプル数。48 kHz なら約 85 ミリ秒ごと |
| `getUserMedia` | `navigator.mediaDevices.getUserMedia` | 差し替え |
| `audioContext` | グローバル | `AudioContext` を作る関数。`webkitAudioContext` も見る |
| `onWarning` | — | 上の表の通知 |

## 気をつけている点

実際に端末で踏んだところを、そのまま作りに入れてある。

- **出力先を無音にする。** Bluetooth に繋がっていると `AudioContext` の出力先が Bluetooth 側になり、マイク入力との全二重通信を確立できない端末がある。そうなるとレンダースレッドが止まり、フレームが1つも届かなくなる。`setSinkId({ type: "none" })` で出力を開かない。iOS Safari は非対応なので、あるときだけ呼ぶ
- **`suspended` で始まったら `resume` する。** Android Chrome では `getUserMedia` の `await` を挟むと `AudioContext` が `suspended` で始まる。これを起こさないとフレームが届かない
- **やり直すのは「今はほかが使っている」たぐいの失敗だけ。** `AbortError` / `InvalidStateError` / `NotReadableError` / `TrackStartError` は 250 ミリ秒置いて1回だけ取り直す。権限が無い・端末が無いは何度試しても同じなので、そのまま返す
- **組み立てに失敗したら、掴んだマイクを自分で手放す。** ここで手放さないと、誰にも配られないまま開きっぱなしのデバイスが残り、次に開こうとしたものが取れなくなる
- **同時に開こうとしたぶんは1本にまとめる。** 素通しすると2本目のデバイスが開く

## 既知の制限

- 中身は `ScriptProcessorNode`。仕様としては非推奨だが、iOS Safari を含めどこでも動くのが確認できている唯一の経路なので、当面はこれで出す。`AudioWorklet` への差し替えは検討中
- 音声の加工はしない。リサンプルやフォーマットの変換は受け取り側の仕事

## ライセンス

MIT
