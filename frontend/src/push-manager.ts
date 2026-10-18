import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';

export interface PushSettings {
  enabled: boolean;
  soundChoice: 'chime' | 'radar' | 'urgent' | 'cash' | 'default';
  deviceToken: string | null;
}

class NativePushManager {
  private settings: PushSettings = {
    enabled: true,
    soundChoice: 'chime',
    deviceToken: null,
  };

  private currentAudio: HTMLAudioElement | null = null;

  constructor() {
    this.loadSettings();
  }

  public async init() {
    console.log('[NativePushManager] Initializing native notification subsystem...');
    try {
      this.bindUI();
      if (Capacitor.isNativePlatform()) {
        await this.setupChannels();
        this.updateStatusBadge('Active · Sound Ready', '#238636');
      } else {
        console.log('[NativePushManager] Web browser environment detected - web audio preview active.');
      }
    } catch (e) {
      console.warn('[NativePushManager] Initialization error caught safely:', e);
    }
  }

  private loadSettings() {
    try {
      const savedSound = localStorage.getItem('btc_push_sound') as PushSettings['soundChoice'] | null;
      const savedEnabled = localStorage.getItem('btc_push_enabled');
      const savedToken = localStorage.getItem('btc_push_token');

      if (savedSound) this.settings.soundChoice = savedSound;
      if (savedEnabled !== null) this.settings.enabled = savedEnabled === 'true';
      if (savedToken) this.settings.deviceToken = savedToken;
    } catch (e) {
      console.warn('[NativePushManager] Error loading settings:', e);
    }
  }

  private saveSettings() {
    try {
      localStorage.setItem('btc_push_sound', this.settings.soundChoice);
      localStorage.setItem('btc_push_enabled', String(this.settings.enabled));
      if (this.settings.deviceToken) {
        localStorage.setItem('btc_push_token', this.settings.deviceToken);
      }
      this.syncWithBackend();
    } catch (e) {
      console.warn('[NativePushManager] Error saving settings:', e);
    }
  }

  /**
   * Configure Android 8.0+ notification channels with custom sound resources
   */
  private async setupChannels() {
    if (!Capacitor.isNativePlatform()) return;

    try {
      // 1. Chime Channel
      await LocalNotifications.createChannel({
        id: 'btc_alerts_chime',
        name: 'BTC Volatility: Chime Bell',
        description: 'Clean crystalline bell tone for options volatility alerts',
        sound: 'chime.wav',
        importance: 5,
        visibility: 1,
        vibration: true,
      });

      // 2. Radar Channel
      await LocalNotifications.createChannel({
        id: 'btc_alerts_radar',
        name: 'BTC Volatility: Radar Pulse',
        description: 'Sonar pulse for strangle signals and speed breaks',
        sound: 'radar.wav',
        importance: 5,
        visibility: 1,
        vibration: true,
      });

      // 3. Urgent Channel
      await LocalNotifications.createChannel({
        id: 'btc_alerts_urgent',
        name: 'BTC Volatility: Urgent Alert',
        description: 'High-priority two-tone urgent alert',
        sound: 'urgent.wav',
        importance: 5,
        visibility: 1,
        vibration: true,
      });

      // 4. Cash Channel
      await LocalNotifications.createChannel({
        id: 'btc_alerts_cash',
        name: 'BTC Volatility: Cash Register',
        description: 'Positive target / fill confirmation chime',
        sound: 'cash.wav',
        importance: 5,
        visibility: 1,
        vibration: true,
      });

      // 5. System Default Channel
      await LocalNotifications.createChannel({
        id: 'btc_alerts_default',
        name: 'BTC Volatility: Standard Tone',
        description: 'Default Android OS notification tone',
        importance: 4,
        visibility: 1,
      });

      console.log('[NativePushManager] Android notification channels successfully configured.');
    } catch (err) {
      console.warn('[NativePushManager] Channel setup notice:', err);
    }
  }

  /**
   * Plays in-app sound preview using HTML5 Audio
   */
  public playSoundPreview(soundName: string) {
    try {
      if (this.currentAudio) {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      }

      const soundUrl = `/sounds/${soundName}.wav`;
      this.currentAudio = new Audio(soundUrl);
      this.currentAudio.volume = 0.9;
      this.currentAudio.play().catch((e) => {
        console.warn('[NativePushManager] Audio playback notice:', e);
      });
    } catch (err) {
      console.error('[NativePushManager] Error playing sound preview:', err);
    }
  }

  /**
   * Triggers a native local notification banner with the configured sound channel
   */
  public async triggerLocalNotification(title: string, body: string, soundChoice: string) {
    if (!this.settings.enabled) return;

    // Play in-app audio
    if (soundChoice !== 'default') {
      this.playSoundPreview(soundChoice);
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const channelId = `btc_alerts_${soundChoice}`;
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Math.floor(Date.now() % 100000),
              title: title,
              body: body,
              channelId: channelId,
              sound: soundChoice !== 'default' ? `${soundChoice}.wav` : undefined,
              smallIcon: 'ic_launcher',
              extra: { soundChoice },
            },
          ],
        });
      } catch (err) {
        console.warn('[NativePushManager] Notice scheduling local notification:', err);
      }
    }
  }

  /**
   * Requests Android notification permissions safely
   */
  public async requestPermissions() {
    if (!Capacitor.isNativePlatform()) {
      alert('Running in web browser. On mobile, this configures Android notifications.');
      return;
    }

    try {
      const localPerm = await LocalNotifications.requestPermissions();
      console.log('[NativePushManager] Local notifications permission:', localPerm);

      try {
        const pushPerm = await PushNotifications.requestPermissions();
        if (pushPerm.receive === 'granted') {
          // Attempt register safely with catch to avoid unhandled native crash
          PushNotifications.register().catch((err) => {
            console.warn('[NativePushManager] FCM register note:', err);
          });
        }
      } catch (pushErr) {
        console.warn('[NativePushManager] Push register not available:', pushErr);
      }

      alert('Notification channels and alert sounds are active on this device!');
      this.updateStatusBadge('Active · Sound Ready', '#238636');
    } catch (e: any) {
      alert('Notification permission: ' + (e?.message || e));
    }
  }

  /**
   * Syncs device token and alert sound preference with Fastify backend
   */
  public async syncWithBackend() {
    try {
      const token = this.settings.deviceToken || 'device_' + (localStorage.getItem('btc_device_uuid') || crypto.randomUUID());
      localStorage.setItem('btc_device_uuid', token);

      await fetch('/api/v1/alerts/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token,
          platform: Capacitor.getPlatform(),
          soundChoice: this.settings.soundChoice,
          enabled: this.settings.enabled,
        }),
      }).catch(() => {});
    } catch (err) {
      // Offline fallback
    }
  }

  private updateStatusBadge(text: string, color: string) {
    const badge = document.getElementById('pushStatusBadge');
    if (badge) {
      badge.textContent = text;
      badge.style.color = color;
    }
  }

  /**
   * Binds UI controls in the Settings tab
   */
  private bindUI() {
    const soundSelect = document.getElementById('pushSoundSelect') as HTMLSelectElement | null;
    const togglePush = document.getElementById('togglePushAlerts') as HTMLInputElement | null;
    const btnPlay = document.getElementById('btnPlaySoundPreview');
    const btnTest = document.getElementById('btnTriggerTestPush');
    const btnPerm = document.getElementById('btnRequestPushPerm');

    if (soundSelect) {
      soundSelect.value = this.settings.soundChoice;
      soundSelect.addEventListener('change', () => {
        this.settings.soundChoice = soundSelect.value as any;
        this.saveSettings();
        this.playSoundPreview(this.settings.soundChoice);
      });
    }

    if (togglePush) {
      togglePush.checked = this.settings.enabled;
      togglePush.addEventListener('change', () => {
        this.settings.enabled = togglePush.checked;
        this.saveSettings();
        this.updateStatusBadge(this.settings.enabled ? 'Active' : 'Disabled', this.settings.enabled ? '#238636' : '#8b949e');
      });
    }

    if (btnPlay && soundSelect) {
      btnPlay.addEventListener('click', () => {
        this.playSoundPreview(soundSelect.value);
      });
    }

    if (btnTest && soundSelect) {
      btnTest.addEventListener('click', () => {
        this.triggerLocalNotification(
          '🚨 BTC Volatility Desk Alert',
          `ATM IV Spiked +4.2% · Sound: ${soundSelect.options[soundSelect.selectedIndex].text}`,
          soundSelect.value
        );
      });
    }

    if (btnPerm) {
      btnPerm.addEventListener('click', () => {
        this.requestPermissions();
      });
    }
  }
}

// Instantiate and expose globally
export const pushManager = new NativePushManager();
(window as any).DeskPushManager = pushManager;

// Safe boot on DOM ready
try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => pushManager.init());
  } else {
    pushManager.init();
  }
} catch (e) {
  console.warn('[NativePushManager] Boot notice:', e);
}
