import { eq } from 'drizzle-orm';
import { db, alertRules, alertLogs } from '../db/index.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

export interface DispatchNotificationOptions {
  title: string;
  message: string;
  channel?: 'telegram' | 'ntfy' | 'in_app';
  ruleId?: string;
}

export class AlertService {
  private cooldowns: Map<string, number> = new Map(); // ruleId -> timestamp Ms

  /**
   * Dispatches a notification across configured channels and logs to alert_logs in PostgreSQL
   */
  async sendNotification(options: DispatchNotificationOptions): Promise<boolean> {
    const { title, message, channel = 'in_app', ruleId } = options;

    // Check cooldown if ruleId provided
    if (ruleId) {
      const lastSent = this.cooldowns.get(ruleId) || 0;
      const now = Date.now();
      // default 5-min cooldown if not explicitly recorded
      if (now - lastSent < 300_000) {
        return false;
      }
      this.cooldowns.set(ruleId, now);
    }

    let status = 'SENT';

    // 1. Telegram Dispatch
    if (channel === 'telegram' || channel === 'in_app') {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_DEFAULT_CHAT_ID;
      if (botToken && chatId) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `🚨 *${title}*\n\n${message}`,
              parse_mode: 'Markdown',
            }),
          });
        } catch (err: any) {
          console.error('[AlertService] Telegram dispatch error:', err.message);
          status = 'FAILED';
        }
      }
    }

    // 2. ntfy Dispatch
    if (channel === 'ntfy' || channel === 'in_app') {
      const ntfyTopic = process.env.NTFY_DEFAULT_TOPIC || 'btc-volatility-desk';
      const ntfyServer = process.env.NTFY_SERVER_URL || 'https://ntfy.sh';
      try {
        await fetch(`${ntfyServer}/${ntfyTopic}`, {
          method: 'POST',
          headers: {
            Title: title,
            Priority: 'high',
            Tags: 'chart_with_upwards_trend,warning',
          },
          body: message,
        });
      } catch (err: any) {
        console.error('[AlertService] ntfy dispatch error:', err.message);
      }
    }

    // 3. Native Mobile Push Dispatch (Registered Capacitor / FCM devices)
    try {
      const { pushDevices } = await import('../db/index.js');
      const { and, eq } = await import('drizzle-orm');
      const devices = await db
        .select()
        .from(pushDevices)
        .where(and(eq(pushDevices.userId, DEFAULT_USER_ID), eq(pushDevices.enabled, true)));

      for (const dev of devices) {
        const fcmKey = process.env.FCM_SERVER_KEY;
        if (fcmKey && dev.token) {
          try {
            await fetch('https://fcm.googleapis.com/fcm/send', {
              method: 'POST',
              headers: {
                Authorization: `key=${fcmKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                to: dev.token,
                priority: 'high',
                notification: {
                  title,
                  body: message,
                  sound: dev.soundChoice ? `${dev.soundChoice}.wav` : 'chime.wav',
                  android_channel_id: `btc_alerts_${dev.soundChoice || 'chime'}`,
                },
                data: {
                  title,
                  message,
                  soundChoice: dev.soundChoice || 'chime',
                  ruleId: ruleId || '',
                },
              }),
            });
          } catch (fcmErr: any) {
            console.error('[AlertService] FCM send error:', fcmErr.message);
          }
        }
      }
    } catch (pushErr: any) {
      console.error('[AlertService] Error reading push_devices:', pushErr.message);
    }

    // 4. Log to PostgreSQL alert_logs table
    try {
      await db.insert(alertLogs).values({
        id: crypto.randomUUID(),
        userId: DEFAULT_USER_ID,
        alertRuleId: ruleId || null,
        title: title.slice(0, 200),
        message: message,
        channel: channel,
        status: status,
        deliveredAt: new Date(),
      });
    } catch (dbErr: any) {
      console.error('[AlertService] Failed to record alert_log in database:', dbErr.message);
    }

    return true;
  }

  /**
   * Evaluates active rules against incoming live metrics
   */
  async checkMetrics(metrics: {
    spotPrice?: number;
    atmIv?: number;
    ivChangePct?: number;
    realizedVol?: number;
  }) {
    try {
      const activeRules = await db
        .select()
        .from(alertRules)
        .where(eq(alertRules.isActive, true));

      for (const rule of activeRules) {
        const threshold = Number(rule.thresholdValue);
        let triggered = false;
        let alertMessage = '';

        if (rule.ruleType === 'IV_SPIKE' && metrics.ivChangePct != null) {
          if (metrics.ivChangePct >= threshold) {
            triggered = true;
            alertMessage = `ATM IV spiked by ${metrics.ivChangePct.toFixed(2)}% (Threshold: ${threshold}%). Current ATM IV: ${metrics.atmIv?.toFixed(2)}%`;
          }
        } else if (rule.ruleType === 'SPEED_BREAK' && metrics.spotPrice != null) {
          // spot velocity or barrier
          if (metrics.spotPrice >= threshold) {
            triggered = true;
            alertMessage = `BTC Spot crossed threshold $${threshold.toLocaleString()}. Current spot: $${metrics.spotPrice.toLocaleString()}`;
          }
        }

        if (triggered) {
          const channels = Array.isArray(rule.channels) ? rule.channels : ['telegram', 'ntfy', 'in_app'];
          for (const ch of channels) {
            await this.sendNotification({
              title: `[ALERT] ${rule.ruleName}`,
              message: alertMessage,
              channel: ch as any,
              ruleId: rule.id,
            });
          }
        }
      }
    } catch (err: any) {
      console.error('[AlertService] Rule evaluation error:', err.message);
    }
  }
}

export const alertService = new AlertService();
