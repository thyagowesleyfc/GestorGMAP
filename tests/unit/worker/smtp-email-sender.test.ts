import { describe, expect, it, vi } from "vitest";

import {
  resolveSmtpEmailSenderConfig,
  SmtpEmailSender,
  type SmtpMail,
  type SmtpTransportFactory
} from "../../../src/worker/email/smtp-email-sender";

describe("smtp email sender", () => {
  it("resolves SMTP settings from env", () => {
    expect(
      resolveSmtpEmailSenderConfig({
        GMAP_SMTP_HOST: " smtp.example.test ",
        GMAP_SMTP_PORT: "587",
        GMAP_SMTP_SECURE: "false",
        GMAP_SMTP_FROM: " GMAP <gmap@example.test> ",
        GMAP_SMTP_USERNAME: " user ",
        GMAP_SMTP_PASSWORD: " secret "
      })
    ).toEqual({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      from: "GMAP <gmap@example.test>",
      username: "user",
      password: "secret"
    });
  });

  it("uses insecure SMTP by default when GMAP_SMTP_SECURE is omitted", () => {
    expect(
      resolveSmtpEmailSenderConfig({
        GMAP_SMTP_HOST: "smtp.example.test",
        GMAP_SMTP_PORT: "25",
        GMAP_SMTP_FROM: "gmap@example.test"
      }).secure
    ).toBe(false);
  });

  it("fails fast when required SMTP settings are invalid", () => {
    expect(() => resolveSmtpEmailSenderConfig({})).toThrow(/GMAP_SMTP_HOST/);
    expect(() =>
      resolveSmtpEmailSenderConfig({
        GMAP_SMTP_HOST: "smtp.example.test",
        GMAP_SMTP_PORT: "0",
        GMAP_SMTP_FROM: "gmap@example.test"
      })
    ).toThrow(/GMAP_SMTP_PORT/);
    expect(() =>
      resolveSmtpEmailSenderConfig({
        GMAP_SMTP_HOST: "smtp.example.test",
        GMAP_SMTP_PORT: "587",
        GMAP_SMTP_SECURE: "sim",
        GMAP_SMTP_FROM: "gmap@example.test"
      })
    ).toThrow(/GMAP_SMTP_SECURE/);
    expect(() =>
      resolveSmtpEmailSenderConfig({
        GMAP_SMTP_HOST: "smtp.example.test",
        GMAP_SMTP_PORT: "587"
      })
    ).toThrow(/GMAP_SMTP_FROM/);
    expect(() =>
      resolveSmtpEmailSenderConfig({
        GMAP_SMTP_HOST: "smtp.example.test",
        GMAP_SMTP_PORT: "587",
        GMAP_SMTP_FROM: "gmap@example.test",
        GMAP_SMTP_USERNAME: "user"
      })
    ).toThrow(/GMAP_SMTP_USERNAME e GMAP_SMTP_PASSWORD/);
  });

  it("sends email through a SMTP transport", async () => {
    const sent: SmtpMail[] = [];
    const factory: SmtpTransportFactory = vi.fn(() => ({
      sendMail: async (message: SmtpMail) => {
        sent.push(message);
      }
    }));
    const sender = new SmtpEmailSender(
      {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        from: "GMAP <gmap@example.test>",
        username: "user",
        password: "secret"
      },
      factory
    );

    await sender.send({
      to: ["gerencia@example.test"],
      subject: "Entrega registrada",
      text: "A entrega foi registrada.",
      metadata: { correlation_id: "corr-1" }
    });

    expect(factory).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      auth: {
        user: "user",
        pass: "secret"
      }
    });
    expect(sent).toEqual([
      {
        from: "GMAP <gmap@example.test>",
        to: ["gerencia@example.test"],
        subject: "Entrega registrada",
        text: "A entrega foi registrada.",
        headers: { correlation_id: "corr-1" }
      }
    ]);
  });

  it("rejects messages without recipients", async () => {
    const sender = new SmtpEmailSender(
      {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        from: "gmap@example.test"
      },
      () => ({
        sendMail: async () => undefined
      })
    );

    await expect(
      sender.send({
        to: [],
        subject: "Entrega registrada",
        text: "A entrega foi registrada."
      })
    ).rejects.toThrow(/sem destinatarios/);
  });
});
