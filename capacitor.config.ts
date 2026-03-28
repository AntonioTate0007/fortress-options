import type { CapacitorConfig } from '@capacitor/core';

const config: CapacitorConfig = {
  appId: 'com.fortress.options',
  appName: 'Fortress Options',
  webDir: 'dist',
  plugins: {
    BiometricAuth: {
      androidBiometricStrength: 'BIOMETRIC_STRONG',
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#10B981',
    },
  },
};

export default config;
