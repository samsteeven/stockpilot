import { DynamicModule, Inject, Injectable, Module } from '@nestjs/common';
import { type Notification, TenantDatabase } from '@stockpilot/database';
import type { DomainEvent } from '@stockpilot/messaging';
import {
  LogMailSender,
  MAIL_SENDER,
  type MailSender,
  SmtpMailSender,
} from './mail-sender.js';
import { render } from './templates.js';

export type NotificationOutcome =
  'sent' | 'already-sent' | 'no-template' | 'no-recipient';

/**
 * Messages au client, déclenchés par les événements du domaine.
 *
 * Le message est d'abord enregistré (une ligne par événement et par modèle, contrainte d'unicité), puis envoyé
 * hors transaction : un envoi lent ne garde pas de verrou, et un message déjà envoyé n'est pas renvoyé quand
 * l'événement est relivré. Échec d'envoi : la ligne garde l'erreur, et l'exception fait rejouer le job.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly tenants: TenantDatabase,
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
  ) {}

  async handle(event: DomainEvent): Promise<NotificationOutcome> {
    const orderId = event.payload['orderId'];
    if (!event.tenantId || typeof orderId !== 'string') return 'no-template';
    const tenantId = event.tenantId;

    const prepared = await this.tenants.run(tenantId, async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { tenant: { select: { name: true } } },
      });
      if (!order) return 'no-template' as const;
      const message = render(event, {
        orderId: order.id,
        tenantName: order.tenant.name,
        totalAmount: order.totalAmount.toFixed(2),
        currency: order.currency,
        cancelReason: order.cancelReason,
      });
      if (!message) return 'no-template' as const;
      if (!order.customerEmail) return 'no-recipient' as const;
      await tx.notification.createMany({
        data: [
          {
            tenantId,
            eventId: event.id,
            template: message.template,
            recipient: order.customerEmail,
            subject: message.subject,
            body: message.body,
          },
        ],
        skipDuplicates: true,
      });
      return tx.notification.findUniqueOrThrow({
        where: {
          eventId_template: { eventId: event.id, template: message.template },
        },
      });
    });
    if (typeof prepared === 'string') return prepared;
    if (prepared.status === 'SENT') return 'already-sent';

    try {
      await this.sender.send({
        to: prepared.recipient,
        subject: prepared.subject,
        text: prepared.body,
      });
    } catch (error) {
      await this.tenants.run(tenantId, (tx) =>
        tx.notification.update({
          where: { id: prepared.id },
          data: {
            status: 'FAILED',
            attempts: { increment: 1 },
            lastError: (error as Error).message.slice(0, 1000),
          },
        }),
      );
      throw error;
    }
    await this.tenants.run(tenantId, (tx) =>
      tx.notification.update({
        where: { id: prepared.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      }),
    );
    return 'sent';
  }

  list(tenantId: string, limit = 50): Promise<Notification[]> {
    return this.tenants.run(tenantId, (tx) =>
      tx.notification.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(limit, 1), 200),
      }),
    );
  }
}

export interface NotificationsOptions {
  /** smtp://hôte:port ; absent : les messages sont seulement journalisés. */
  smtpUrl?: string;
  mailFrom: string;
}

@Module({})
export class NotificationsModule {
  static forRoot(options: NotificationsOptions): DynamicModule {
    return {
      module: NotificationsModule,
      providers: [
        {
          provide: MAIL_SENDER,
          useValue: options.smtpUrl
            ? new SmtpMailSender(options.smtpUrl, options.mailFrom)
            : new LogMailSender(),
        },
        NotificationService,
      ],
      exports: [NotificationService],
    };
  }
}
