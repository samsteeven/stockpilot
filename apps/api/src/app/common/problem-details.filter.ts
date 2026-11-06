import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { METRICS, type Metrics } from '@stockpilot/observability';
import {
  DuplicateSkuError,
  DuplicateWarehouseCodeError,
  ProductNotFoundError,
} from '@stockpilot/catalog';
import { InvalidTenantError } from '@stockpilot/database';
import {
  EmailTakenError,
  InvalidAccessTokenError,
  InvalidCredentialsError,
  InvalidSessionError,
} from '@stockpilot/identity';
import {
  AlreadyMemberError,
  InvitationEmailMismatchError,
  InvitationInvalidError,
  LastOwnerError,
  MemberNotFoundError,
  RoleChangeForbiddenError,
  TenantNotFoundError,
} from '@stockpilot/tenancy';
import {
  InsufficientStockError,
  ReservationExpiredError,
  ReservationNotActiveError,
  ReservationNotFoundError,
  UnknownStockItemError,
} from '@stockpilot/inventory';
import {
  IdempotencyKeyReuseError,
  InvalidPaymentEventError,
  InvalidSignatureError,
  MixedCurrencyError,
  OrderNotCancellableError,
  OrderNotFoundError,
  PaymentMismatchError,
  PaymentNotFoundError,
  UnknownVariantError,
  UnknownWarehouseError,
} from '@stockpilot/orders';
import {
  ShipmentNotFoundError,
  ShipmentStateError,
} from '@stockpilot/shipping';
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

  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const problem = this.toProblem(error);
    this.metrics.problems.inc({
      status: String(problem.status),
      title: problem.title,
    });
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(problem.status)
      .type('application/problem+json')
      .send(problem);
  }

  /** Erreurs du domaine sans détail particulier : un statut et un titre. */
  private simpleProblem(error: unknown): Problem | undefined {
    const table: [new (...args: never[]) => Error, number, string][] = [
      [
        InvalidCredentialsError,
        HttpStatus.UNAUTHORIZED,
        'E-mail ou mot de passe incorrect',
      ],
      [
        InvalidSessionError,
        HttpStatus.UNAUTHORIZED,
        'Session invalide ou expirée',
      ],
      [
        InvalidAccessTokenError,
        HttpStatus.UNAUTHORIZED,
        'Jeton invalide ou expiré',
      ],
      [EmailTakenError, HttpStatus.CONFLICT, 'Adresse déjà utilisée'],
      [TenantNotFoundError, HttpStatus.NOT_FOUND, 'Entreprise introuvable'],
      [MemberNotFoundError, HttpStatus.NOT_FOUND, 'Membre introuvable'],
      [ProductNotFoundError, HttpStatus.NOT_FOUND, 'Produit introuvable'],
      [
        RoleChangeForbiddenError,
        HttpStatus.FORBIDDEN,
        'Changement de rôle interdit',
      ],
      [
        InvitationEmailMismatchError,
        HttpStatus.FORBIDDEN,
        'Invitation destinée à une autre adresse',
      ],
      [LastOwnerError, HttpStatus.CONFLICT, 'Dernier propriétaire'],
      [AlreadyMemberError, HttpStatus.CONFLICT, 'Déjà membre'],
      [InvitationInvalidError, HttpStatus.GONE, 'Invitation inutilisable'],
      [DuplicateSkuError, HttpStatus.CONFLICT, 'Référence déjà utilisée'],
      [
        DuplicateWarehouseCodeError,
        HttpStatus.CONFLICT,
        'Code d’entrepôt déjà utilisé',
      ],
      [OrderNotFoundError, HttpStatus.NOT_FOUND, 'Commande introuvable'],
      [
        OrderNotCancellableError,
        HttpStatus.CONFLICT,
        'Commande plus annulable',
      ],
      [
        IdempotencyKeyReuseError,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Clé d’idempotence déjà utilisée pour une autre requête',
      ],
      [UnknownVariantError, HttpStatus.UNPROCESSABLE_ENTITY, 'Article inconnu'],
      [
        UnknownWarehouseError,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Entrepôt inconnu',
      ],
      [
        MixedCurrencyError,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Plusieurs devises dans une commande',
      ],
      [InvalidSignatureError, HttpStatus.UNAUTHORIZED, 'Signature refusée'],
      [
        InvalidPaymentEventError,
        HttpStatus.BAD_REQUEST,
        'Notification de paiement invalide',
      ],
      [PaymentNotFoundError, HttpStatus.NOT_FOUND, 'Paiement inconnu'],
      [ShipmentNotFoundError, HttpStatus.NOT_FOUND, 'Expédition introuvable'],
      [
        ShipmentStateError,
        HttpStatus.CONFLICT,
        'Transition d’expédition impossible',
      ],
      [
        PaymentMismatchError,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Montant ou devise inattendus',
      ],
    ];
    for (const [type, status, title] of table) {
      if (error instanceof type) {
        return { type: 'about:blank', title, status, detail: error.message };
      }
    }
    return undefined;
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
    const simple = this.simpleProblem(error);
    if (simple) return simple;
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
