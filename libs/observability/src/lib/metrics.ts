import { createServer, type Server } from 'node:http';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

/**
 * Métriques Prometheus d'un processus (API ou worker). Une instance par processus : les compteurs vivent en
 * mémoire et Prometheus les lit sur un port séparé, jamais exposé au public.
 */
export class Metrics {
  readonly registry = new Registry();

  /** Durée des requêtes HTTP, par route (gabarit, pas l'URL réelle) et code de réponse. */
  readonly httpDuration = new Histogram({
    name: 'stockpilot_http_request_duration_seconds',
    help: 'Durée des requêtes HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  /** Erreurs du domaine renvoyées au client (stock insuffisant, clé réutilisée, signature refusée…). */
  readonly problems = new Counter({
    name: 'stockpilot_problems_total',
    help: 'Réponses Problem Details par titre et code',
    labelNames: ['status', 'title'] as const,
    registers: [this.registry],
  });

  readonly orders = new Counter({
    name: 'stockpilot_orders_total',
    help: 'Créations de commande : créées ou rejouées (Idempotency-Key)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly paymentNotifications = new Counter({
    name: 'stockpilot_payment_notifications_total',
    help: 'Notifications du prestataire de paiement par issue',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly domainEvents = new Counter({
    name: 'stockpilot_domain_events_total',
    help: 'Événements du domaine traités par le worker, par type et issue',
    labelNames: ['type', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly eventFailures = new Counter({
    name: 'stockpilot_domain_event_failures_total',
    help: 'Traitements d’événements en échec (rejoués par la file)',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'stockpilot_outbox_pending',
    help: 'Événements écrits mais pas encore publiés',
    registers: [this.registry],
  });

  readonly outboxOldestAge = new Gauge({
    name: 'stockpilot_outbox_oldest_age_seconds',
    help: 'Âge du plus ancien événement non publié (0 si aucun)',
    registers: [this.registry],
  });

  readonly queueJobs = new Gauge({
    name: 'stockpilot_queue_jobs',
    help: 'Jobs BullMQ par file et état',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });

  constructor(service: string) {
    this.registry.setDefaultLabels({ service });
    collectDefaultMetrics({ register: this.registry, prefix: 'stockpilot_' });
  }

  /** Sert /metrics sur son propre port (pas derrière le répartiteur de charge public). */
  listen(port: number, host = '0.0.0.0'): Promise<Server> {
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      this.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': this.registry.contentType });
          res.end(body);
        })
        .catch((error: Error) => {
          res.writeHead(500).end(error.message);
        });
    });
    return new Promise((resolve) =>
      server.listen(port, host, () => resolve(server)),
    );
  }
}

export const METRICS = Symbol('METRICS');
