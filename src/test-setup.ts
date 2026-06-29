import "@testing-library/jest-dom";

// The agent client guards IPC calls behind `window.__TAURI_INTERNALS__` (present
// only inside the Tauri desktop window). Tests mock the @tauri-apps module, not
// the global, so provide a stub here so guarded calls proceed under jsdom.
(globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

// jsdom does not implement ResizeObserver. Radix ScrollArea uses it in a
// layout effect, which fires when userEvent interactions flush async renders.
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
