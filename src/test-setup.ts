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

// Provide localStorage mock for tests since jsdom doesn't enable it by default.
const store: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((key) => {
      delete store[key];
    });
  },
  key: (index: number) => {
    const keys = Object.keys(store);
    return keys[index] ?? null;
  },
  length: Object.keys(store).length,
} as Storage;
