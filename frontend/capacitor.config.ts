import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.suraj.btcvolatilitydesk',
  appName: 'BTC Volatility Desk',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      smallIcon: 'ic_launcher',
      iconColor: '#2F81F7',
      sound: 'chime.wav',
    },
  },
};

export default config;
