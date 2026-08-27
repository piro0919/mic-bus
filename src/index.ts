import { createMicBus } from "./mic-bus.js";

export {
  createMicBus,
  type MicBus,
  type MicBusOptions,
  type MicBusWarning,
  type MicFrameListener,
} from "./mic-bus.js";

/**
 * The shared microphone.
 *
 * There is only one device to open, so this instance is usually the one to use.
 */
export const micBus = createMicBus();
