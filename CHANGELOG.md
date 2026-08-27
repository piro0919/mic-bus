# Changelog

## 0.1.2

### Changed

- Ships both ESM and CJS builds with source maps, so `require()` works alongside
  `import`.

## 0.1.1

### Changed

- Everything is written in English: README, source comments and type documentation.
  The first release carried Japanese prose, which is unhelpful in a public package.

## 0.1.0

Initial release, published as `shared-microphone`. The name `mic-bus` was rejected
by npm as too similar to the existing `micbus`.

### Added

- `micBus` / `createMicBus` — open the microphone once and share its frames with
  every consumer. Handles the device quirks found in production: silencing the
  output sink so Bluetooth does not stall the render thread, resuming a context that
  starts suspended, retrying only the failures worth retrying, releasing an acquired
  microphone when wiring fails, and collapsing concurrent opens into one.
