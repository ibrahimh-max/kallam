export type AuthEmailPurpose = 'verify_email' | 'password_recovery';

export interface AuthEmail {
  to: string;
  purpose: AuthEmailPurpose;
  actionUrl: string;
}

export interface EmailDelivery {
  readonly configured: boolean;
  sendVerification(to: string, actionUrl: string): Promise<void>;
  sendPasswordRecovery(to: string, actionUrl: string): Promise<void>;
}

export interface EmailDeliveryConfig {
  provider: 'disabled' | 'mock' | 'resend';
  apiKey: string;
  from: string;
}

export class EmailDeliveryError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super(status === null ? 'email delivery request failed' : `email provider returned ${status}`);
    this.name = 'EmailDeliveryError';
    this.status = status;
  }
}

export class DisabledEmailDelivery implements EmailDelivery {
  readonly configured = false;

  async sendVerification(): Promise<void> {
    throw new EmailDeliveryError(null);
  }

  async sendPasswordRecovery(): Promise<void> {
    throw new EmailDeliveryError(null);
  }
}

/** Test-only sender. Captured links are exposed only by the test environment. */
export class MockEmailDelivery implements EmailDelivery {
  readonly configured = true;
  readonly messages: AuthEmail[] = [];

  async sendVerification(to: string, actionUrl: string): Promise<void> {
    this.messages.push({ to, purpose: 'verify_email', actionUrl });
  }

  async sendPasswordRecovery(to: string, actionUrl: string): Promise<void> {
    this.messages.push({ to, purpose: 'password_recovery', actionUrl });
  }
}

export class ResendEmailDelivery implements EmailDelivery {
  readonly configured = true;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetcher: typeof fetch;

  constructor(
    apiKey: string,
    from: string,
    fetcher: typeof fetch = fetch,
  ) {
    if (apiKey.length === 0 || from.length === 0) throw new Error('Resend requires an API key and a verified sender');
    this.apiKey = apiKey;
    this.from = from;
    this.fetcher = fetcher;
  }

  sendVerification(to: string, actionUrl: string): Promise<void> {
    return this.send(to, 'تحقق من بريدك الإلكتروني - Saudi English Tutor', [
      'استخدم الرابط التالي لتأكيد بريدك الإلكتروني:',
      actionUrl,
      'إذا لم تطلب إنشاء حساب، تجاهل هذه الرسالة.',
    ].join('\n\n'));
  }

  sendPasswordRecovery(to: string, actionUrl: string): Promise<void> {
    return this.send(to, 'إعادة تعيين كلمة المرور - Saudi English Tutor', [
      'استخدم الرابط التالي لإعادة تعيين كلمة المرور:',
      actionUrl,
      'إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة.',
    ].join('\n\n'));
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from: this.from, to: [to], subject, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new EmailDeliveryError(null);
    }
    if (!response.ok) throw new EmailDeliveryError(response.status);
  }
}

export function createEmailDelivery(config: EmailDeliveryConfig): EmailDelivery {
  switch (config.provider) {
    case 'mock':
      return new MockEmailDelivery();
    case 'resend':
      return new ResendEmailDelivery(config.apiKey, config.from);
    case 'disabled':
      return new DisabledEmailDelivery();
  }
}
