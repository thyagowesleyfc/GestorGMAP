import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import type { EmailMessage, EmailSender } from "./email-sender";

export type SmtpEmailSenderConfig = {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  username?: string;
  password?: string;
};

export type SmtpEmailSenderEnv = Readonly<Record<string, string | undefined>>;

export type SmtpMail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
};

export type SmtpTransport = {
  sendMail(message: SmtpMail): Promise<unknown>;
};

export type SmtpTransportFactory = (options: SMTPTransport.Options) => SmtpTransport;

export class SmtpEmailSender implements EmailSender {
  private readonly transport: SmtpTransport;

  constructor(
    private readonly config: SmtpEmailSenderConfig,
    transportFactory: SmtpTransportFactory = createSmtpTransport
  ) {
    this.transport = transportFactory(toTransportOptions(config));
  }

  async send(message: EmailMessage): Promise<void> {
    if (message.to.length === 0) {
      throw new Error("Mensagem de e-mail sem destinatarios.");
    }

    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      headers: message.metadata
    });
  }
}

export function resolveSmtpEmailSenderConfig(
  env: SmtpEmailSenderEnv = process.env
): SmtpEmailSenderConfig {
  const host = normalizeRequired(env.GMAP_SMTP_HOST, "GMAP_SMTP_HOST");
  const port = parsePort(env.GMAP_SMTP_PORT);
  const secure = parseSecure(env.GMAP_SMTP_SECURE);
  const from = normalizeRequired(env.GMAP_SMTP_FROM, "GMAP_SMTP_FROM");
  const username = normalizeOptional(env.GMAP_SMTP_USERNAME);
  const password = normalizeOptional(env.GMAP_SMTP_PASSWORD);

  if ((username === undefined) !== (password === undefined)) {
    throw new Error("GMAP_SMTP_USERNAME e GMAP_SMTP_PASSWORD devem ser informados em conjunto.");
  }

  return {
    host,
    port,
    secure,
    from,
    ...(username === undefined ? {} : { username, password })
  };
}

function createSmtpTransport(options: SMTPTransport.Options): SmtpTransport {
  return nodemailer.createTransport(options);
}

function toTransportOptions(config: SmtpEmailSenderConfig): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.username === undefined
        ? undefined
        : {
            user: config.username,
            pass: config.password
          }
  };
}

function normalizeRequired(value: string | undefined, name: string): string {
  const normalized = normalizeOptional(value);

  if (normalized === undefined) {
    throw new Error(`${name} deve ser informado.`);
  }

  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = (value ?? "").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function parsePort(value: string | undefined): number {
  const normalized = (value ?? "").trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error("GMAP_SMTP_PORT deve ser um inteiro entre 1 e 65535.");
  }

  const parsed = Number(normalized);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("GMAP_SMTP_PORT deve ser um inteiro entre 1 e 65535.");
  }

  return parsed;
}

function parseSecure(value: string | undefined): boolean {
  const normalized = (value ?? "false").trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error("GMAP_SMTP_SECURE deve ser true ou false.");
}
