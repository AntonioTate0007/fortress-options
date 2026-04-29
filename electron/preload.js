import { contextBridge, ipcRenderer } from 'electron';

// Expose a minimal, typed bridge to the renderer.
// The renderer calls window.electronAPI.* to talk to the main process.
contextBridge.exposeInMainWorld('electronAPI', {
  /** Open the Robinhood split-panel for a given symbol.
   *  tradeDetails (optional) is copied to the clipboard automatically. */
  openRobinhood: (symbol, tradeDetails) =>
    ipcRenderer.invoke('robinhood:open', { symbol, tradeDetails }),

  /** Close the Robinhood panel and restore full-width Fortress view. */
  closeRobinhood: () =>
    ipcRenderer.invoke('robinhood:close'),

  /** True when running inside Electron (vs browser / Capacitor). */
  isElectron: true,
});
