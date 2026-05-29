import '@testing-library/jest-dom';

// jsdom does not implement ResizeObserver. Provide a no-op stub so components
// that use Radix UI primitives (Slider, etc.) don't throw.
if (typeof ResizeObserver === 'undefined') {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not implement HTMLMediaElement.prototype.play/pause.
// Mock them globally so any component that calls audio.play() or audio.pause()
// doesn't throw in the test environment.
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: vi.fn().mockResolvedValue(undefined),
});
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  writable: true,
  value: vi.fn(),
});
Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  writable: true,
  value: vi.fn(),
});
