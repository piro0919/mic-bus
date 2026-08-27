import { createMicBus } from "./mic-bus.js";

export {
  createMicBus,
  type MicBus,
  type MicBusOptions,
  type MicBusWarning,
  type MicFrameListener,
} from "./mic-bus.js";

/**
 * 既定の共有マイク。
 *
 * 開くのは端末に1本なので、普通はこれを使い回せばよい。
 */
export const micBus = createMicBus();
