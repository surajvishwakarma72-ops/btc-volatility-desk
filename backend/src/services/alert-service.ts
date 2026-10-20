import { eq } from 'drizzle-orm';
import { db, alertRules, alertLogs } from '../db/index.js';
import { CooldownGate } from '../lib/cooldown.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';
const RULES_CACHE_TTL_MS = 30_000;

type Channel = 'telegram' | 'ntfy' | 'in_app';

export interface DispatchNotificationOptions {
  title: string;
  message: string;
  channels?: Channel[];
  ruleId?: string;
  cooldownMs?: number;
}

export class AlertService {
  private gate = new CooldownGate();
  private rulesCache: any[] | null = null;
  private rulesCachedAt = 0;

  /** Call after any rule create/delete to force a reload. */
  invalidateRulesCache() {
    this.rulesCache = null;
  }

  private async getActiveRules(): Promise<any[]> {
    const now = Date.now();
    if (this.rulesCache && now - this.rulesCachedAt < RULES_CACHE_TTL_MS) {
      return this.rulesCache;
    }
    const rules = await db.select().from(alertRules).where(eq(alertRules.isActive, true));
    this.rulesCache = rules;
    this.rulesCachedAt = now;
    return rules;
  }

  /**
   * Dispatch a notification to ALL requested channels in one call and log it.
   * Cooldown (if ruleId given) is checked once per rule and gates the whole dispatch.
   */
  async sendNotification(options: DispatchNotificationOptions): Promise<boolean> {
    const { title, message, channels = ['in_app'], ruleId, cooldownMs = 300_000 } = options;

    if (ruleId && !this.gate.allow(ruleId, Date.now(), cooldownMs)) {
      return false;
    }

    const wantTelegram = channels.includes('telegram') || channels.includes('in_app');
    const wantNtfy = channels.includes('ntfy') || channels.includes('in_app');
    let status = 'SENT';

    if (wantTelegram) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_DEFAULT_CHAT_ID;
      if (botToken && chatId) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: `🚨 *${title}*\n\n${message}`, parse_mode: 'Markdown' }),
          });
        } catch (err: any) {
          console.error('[AlertService] Telegram dispatch error:', err.message);
          status = 'FAILED';
        }
      }
    }

    if (wantNtfy) {
      const ntfyTopic = process.env.NTFY_DEFAULT_TOPIC || 'btc-volatility-desk';
      const ntfyServer = process.env.NTFY_SERVER_URL || 'https://ntfy.sh';
      try {
        await fetch(`${ntfyServer}/${ntfyTopic}`, {
          method: 'POST',
          headers: { Title: title, Priority: 'high', Tags: 'chart_with_upwards_trend,warning' },
          body: message,
        });
      } catch (err: any) {
        console.error('[AlertService] ntfy dispatch error:', err.message);
      }
    }

    // Web push to registered devices
    try {
      const { pushDevices } = await import('../db/index.js');
      const { and, eq: eqOp } = await import('drizzle-orm');
      const devices = await db
        .select()
        .from(pushDevices)
        .where(and(eqOp(pushDevices.userId, DEFAULT_USER_ID), eqOp(pushDevices.enabled, true)));
      const fcmKey = process.env.FCM_SERVER_KEY;
      for (const dev of devices) {
        if (fcmKey && dev.token) {
          try {
            await fetch('https://fcm.googleapis.com/fcm/send', {
              method: 'POST',
              headers: { Authorization: `key=${fcmKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: dev.token,
                priority: 'high',
                notification: {
                  title, body: message,
                  sound: dev.soundChoice ? `${dev.soundChoice}.wav` : 'chime.wav',
                  android_channel_id: `btc_alerts_${dev.soundChoice || 'chime'}`,
                },
                data: { title, message, soundChoice: dev.soundChoice || 'chime', ruleId: ruleId || '' },
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

    // Log once per dispatch
    try {
      await db.insert(alertLogs).values({
        id: crypto.randomUUID(),
        userId: DEFAULT_USER_ID,
        alertRuleId: ruleId || null,
        title: title.slice(0, 200),
        message,
        channel: channels.join(','),
        status,
        deliveredAt: new Date(),
      });
    } catch (dbErr: any) {
      console.error('[AlertService] Failed to record alert_log:', dbErr.message);
    }

    return true;
  }

  /** Evaluate active rules against incoming live metrics. */
  async checkMetrics(metrics: {
    spotPrice?: number;
    atmIv?: number;
    ivChangePct?: number;
    realizedVol?: number;
    speed?: number;
  }) {
    try {
      const activeRules = await this.getActiveRules();
      for (const rule of activeRules) {
        const threshold = Number(rule.thresholdValue);
        let triggered = false;
        let alertMessage = '';

        if (rule.ruleType === 'IV_SPIKE' && metrics.ivChangePct != null) {
          if (metrics.ivChangePct >= threshold) {
            triggered = true;
            alertMessage = `ATM IV moved ${metrics.ivChangePct.toFixed(2)}% (threshold ${threshold}%). Current IV: ${metrics.atmIv?.toFixed(2)}%`;
          }
        } else if (rule.ruleType === 'SPEED_BREAK' && metrics.speed != null) {
          if (metrics.speed >= threshold) {
            triggered = true;
            alertMessage = `Spot velocity ${metrics.speed.toFixed(2)}% over window exceeded ${threshold}%. Spot: $${metrics.spotPrice?.toLocaleString() ?? 'n/a'}`;
          }
        } else if (rule.ruleType === 'PRICE_LEVEL' && metrics.spotPrice != null) {
          if (metrics.spotPrice >= threshold) {
            triggered = true;
            alertMessage = `BTC spot crossed $${threshold.toLocaleString()}. Current: $${metrics.spotPrice.toLocaleString()}`;
          }
        }

        if (triggered) {
          const channels = Array.isArray(rule.channels) && rule.channels.length
            ? (rule.channels as Channel[])
            : (['telegram', 'ntfy', 'in_app'] as Channel[]);
          const cooldownMs = (Number(rule.cooldownSeconds) || 300) * 1000;
          await this.sendNotification({
            title: `[ALERT] ${rule.ruleName}`,
            message: alertMessage,
            channels,
            ruleId: rule.id,
            cooldownMs,
          });
        }
      }
    } catch (err: any) {
      console.error('[AlertService] Rule evaluation error:', err.message);
    }
  }
}

export const alertService = new AlertService();
