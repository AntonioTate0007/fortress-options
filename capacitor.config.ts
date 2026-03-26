import type { CapacitorConfig } from '@capacitor/core';

const config: CapacitorConfig = {
  appId: 'com.fortress.options',
  appName: 'Fortress Options',
  webDir: 'dist',
  server: {
    // Allow cleartext HTTP connections to your local PC (required on Android 9+)
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
