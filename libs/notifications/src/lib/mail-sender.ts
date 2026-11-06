import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Envoi d'un e-mail. Port : SMTP en production et en démonstration (Mailpit), journal sans SMTP configuré. */
export interface MailSender {
  send(mail: OutgoingMail): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');

export class SmtpMailSender implements MailSender {
  private readonly transport;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    // Délais courts : un serveur SMTP muet ne doit pas bloquer le worker ; le job sera rejoué.
    this.transport = nodemailer.createTransport(smtpUrl, {
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    } as never);
  }

  async send(mail: OutgoingMail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
  }
}

/** Sans SMTP configuré : le message est écrit dans le journal et considéré comme envoyé. */
export class LogMailSender implements MailSender {
  private readonly logger = new Logger('Mail');

  async send(mail: OutgoingMail): Promise<void> {
    this.logger.log(`→ ${mail.to} : ${mail.subject}`);
  }
}
