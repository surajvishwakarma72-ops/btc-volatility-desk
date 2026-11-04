import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface EmailSendResult {
  sent: boolean;
  messageId?: string;
  reason?: string;
  resetLink?: string;
}

export class EmailService {
  private transporter: Transporter | null = null;
  private configured: boolean = false;

  constructor() {
    this.init();
  }

  private init() {
    const host = process.env.SMTP_HOST || process.env.SMTP_SERVER;
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER || process.env.SMTP_USERNAME;
    const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
      this.configured = true;
    } else {
      this.configured = false;
      this.transporter = null;
    }
  }

  public isConfigured(): boolean {
    return this.configured;
  }

  public async sendPasswordResetEmail(email: string, resetLink: string): Promise<EmailSendResult> {
    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || `noreply@${process.env.DOMAIN || 'suraj-voldesk.duckdns.org'}`;
    const subject = 'BTC Volatility Desk · Password Reset Request';

    const textContent = [
      'Hello,',
      '',
      'A password reset was requested for your BTC Volatility Desk account.',
      '',
      `Reset link: ${resetLink}`,
      '',
      'This link will expire in 60 minutes and can only be used once.',
      'If you did not request this reset, you can safely ignore this email.',
      '',
      '— BTC Volatility Desk',
    ].join('\n');

    const htmlContent = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1e293b; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="margin-top: 0; color: #0f172a; font-size: 20px;">Password Reset Request</h2>
        <p style="font-size: 14px; line-height: 1.5; color: #475569;">
          A password reset was requested for your <strong>BTC Volatility Desk</strong> account (<code>${email}</code>).
        </p>
        <p style="margin: 24px 0;">
          <a href="${resetLink}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px;">Set New Password</a>
        </p>
        <p style="font-size: 12px; line-height: 1.5; color: #64748b;">
          Or copy and paste this link into your browser:<br/>
          <a href="${resetLink}" style="color: #2563eb; word-break: break-all;">${resetLink}</a>
        </p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #94a3b8; margin-bottom: 0;">
          This link expires in 60 minutes. If you did not make this request, no action is needed.
        </p>
      </div>
    `;

    if (!this.configured || !this.transporter) {
      console.warn(`[email] SMTP credentials not configured in environment. Generated reset link for ${email}: ${resetLink}`);
      return {
        sent: false,
        reason: 'SMTP not configured in environment (SMTP_HOST/SMTP_USER missing).',
        resetLink,
      };
    }

    try {
      const info = await this.transporter.sendMail({
        from: fromAddress,
        to: email,
        subject,
        text: textContent,
        html: htmlContent,
      });
      return {
        sent: true,
        messageId: info.messageId,
      };
    } catch (err: any) {
      console.error('[email] Error sending password reset email:', err?.message || err);
      return {
        sent: false,
        reason: err?.message || 'Failed to dispatch email via SMTP provider',
        resetLink,
      };
    }
  }
}

export const emailService = new EmailService();
