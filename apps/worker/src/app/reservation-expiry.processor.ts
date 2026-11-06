import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import {
  type ExpireReservationJob,
  RESERVATION_EXPIRY_QUEUE,
  ReservationNotFoundError,
  ReservationService,
} from '@stockpilot/inventory';
import type { Job, Queue } from 'bullmq';

export const SWEEP_EVERY_MS = 30_000;

/**
 * Expire les réservations à leur échéance.
 *
 * - job « expire » : planifié à la création de la réservation ; il recontrôle l'état en base (déjà confirmée,
 *   déjà libérée, pas encore échue : rien à faire), donc un job en retard ou rejoué est sans danger ;
 * - job « sweep » : toutes les 30 s, expire ce que les jobs n'ont pas traité (Redis indisponible au moment de la
 *   planification, job perdu). La base reste la source de vérité de l'échéance.
 */
@Processor(RESERVATION_EXPIRY_QUEUE, { concurrency: 8 })
export class ReservationExpiryProcessor extends WorkerHost {
  private readonly logger = new Logger(ReservationExpiryProcessor.name);

  constructor(private readonly reservations: ReservationService) {
    super();
  }

  async process(
    job: Job<ExpireReservationJob>,
  ): Promise<{ changed: boolean } | { expired: number }> {
    if (job.name === 'sweep') {
      const expired = await this.reservations.sweepExpired(200);
      if (expired > 0)
        this.logger.log(
          `Balayage : ${expired} réservation(s) expirée(s) sans job`,
        );
      return { expired };
    }
    try {
      const { changed } = await this.reservations.expire(
        job.data.tenantId,
        job.data.reservationId,
      );
      return { changed };
    } catch (error) {
      // Supprimée entre-temps : rien à rendre, inutile de réessayer.
      if (error instanceof ReservationNotFoundError) return { changed: false };
      throw error;
    }
  }
}

@Injectable()
export class SweepScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(RESERVATION_EXPIRY_QUEUE) private readonly queue: Queue,
  ) {}

  /** Planificateur répétitif idempotent : plusieurs workers qui démarrent ne créent qu'un balayage. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'sweep-expired-reservations',
      { every: SWEEP_EVERY_MS },
      { name: 'sweep' },
    );
  }
}
