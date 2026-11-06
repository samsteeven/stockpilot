import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InvalidTenantError } from '@stockpilot/database';
import {
  InsufficientStockError,
  ReservationExpiredError,
  ReservationNotActiveError,
  ReservationNotFoundError,
  UnknownStockItemError,
} from '@stockpilot/inventory';
import type { Response } from 'express';

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [extension: string]: unknown;
}

/**
 * Toutes les erreurs au format Problem Details (RFC 9457). Les erreurs du domaine deviennent des réponses
 * explicites ; une erreur inattendue devient un 500 sans détail interne (journalisée côté serveur).
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const problem = this.toProblem(error);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(problem.status)
      .type('application/problem+json')
      .send(problem);
  }

  private toProblem(error: unknown): Problem {
    if (error instanceof InsufficientStockError) {
      return {
        type: 'https://stockpilot.dev/problems/insufficient-stock',
        title: 'Stock insuffisant',
        status: HttpStatus.CONFLICT,
        detail: error.message,
        shortages: error.shortages,
      };
    }
    if (error instanceof ReservationNotFoundError) {
      return {
        type: 'about:blank',
        title: 'Réservation introuvable',
        status: HttpStatus.NOT_FOUND,
      };
    }
    if (error instanceof UnknownStockItemError) {
      return {
        type: 'https://stockpilot.dev/problems/unknown-stock-item',
        title: 'Article inconnu dans cet entrepôt',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        variantId: error.variantId,
      };
    }
    if (error instanceof ReservationNotActiveError) {
      return {
        type: 'https://stockpilot.dev/problems/reservation-not-active',
        title: 'Réservation déjà terminée',
        status: HttpStatus.CONFLICT,
        reservationStatus: error.status,
      };
    }
    if (error instanceof ReservationExpiredError) {
      return {
        type: 'https://stockpilot.dev/problems/reservation-expired',
        title: 'Réservation expirée',
        status: HttpStatus.CONFLICT,
        detail: error.message,
      };
    }
    if (error instanceof InvalidTenantError) {
      return {
        type: 'about:blank',
        title: 'Entreprise invalide',
        status: HttpStatus.BAD_REQUEST,
      };
    }
    if (error instanceof HttpException) {
      const response = error.getResponse();
      const detail =
        typeof response === 'object' && response && 'message' in response
          ? (response as { message: unknown }).message
          : error.message;
      return {
        type: 'about:blank',
        title: HttpStatus[error.getStatus()] ?? 'Erreur',
        status: error.getStatus(),
        detail: Array.isArray(detail) ? detail.join(' ; ') : String(detail),
      };
    }
    this.logger.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return {
      type: 'about:blank',
      title: 'Erreur interne',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }
}
