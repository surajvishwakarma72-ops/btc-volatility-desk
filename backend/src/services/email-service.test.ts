import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EmailService } from './email-service.js';

describe('EmailService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  it('reports unconfigured when SMTP environment variables are missing', () => {
    const svc = new EmailService();
    expect(svc.isConfigured()).toBe(false);
  });

  it('safely generates link and warns when SMTP is unconfigured', async () => {
    const svc = new EmailService();
    const res = await svc.sendPasswordResetEmail('trader@example.com', 'https://suraj-voldesk.duckdns.org/#reset=abc&email=trader%40example.com');
    expect(res.sent).toBe(false);
    expect(res.reason).toContain('SMTP not configured');
    expect(res.resetLink).toBe('https://suraj-voldesk.duckdns.org/#reset=abc&email=trader%40example.com');
  });

  it('initializes transporter when SMTP env variables are present', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASS = 'secret123';
    const svc = new EmailService();
    expect(svc.isConfigured()).toBe(true);
  });
});
