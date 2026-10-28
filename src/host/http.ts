import { install } from 'undici';

// Electron 44.9.3 embeds Undici 7.29.1. Use the pinned, patched production
// dependency for every Node request instead of the runtime's vulnerable fetch.
// Install the matching Request/Response/etc. classes together for compatibility.
// This module is Node-only; renderer requests continue to use Chromium's fetch.
install();

// Resolve dynamically so the CLI's --mock network guard and injected test
// transports still intercept all channels, including speech and downloads.
export const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
