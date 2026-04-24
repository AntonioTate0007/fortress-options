/**
 * Ambient type declarations for the Capacitor bridge that the app talks to at
 * runtime. The Capacitor types we have via @capacitor/core don't expose
 * `window.Capacitor`, the dynamic `Plugins` map, or the Preferences plugin
 * surface — so we declare just enough here to drop the @ts-ignore comments
 * that used to mask these accesses in App.tsx.
 *
 * Keep this file *minimal* — only the surface the app actually uses.
 */

interface CapacitorPreferencesPlugin {
  set: (opts: { key: string; value: string }) => Promise<void>;
  get: (opts: { key: string }) => Promise<{ value: string | null }>;
  remove: (opts: { key: string }) => Promise<void>;
}

interface CapacitorPluginsBag {
  Preferences?: CapacitorPreferencesPlugin;
  // Other plugins may be present at runtime — keep this open-ended.
  [key: string]: unknown;
}

interface CapacitorRuntime {
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: CapacitorPluginsBag;
}

declare global {
  interface Window {
    Capacitor?: CapacitorRuntime;
  }
}

export {};
