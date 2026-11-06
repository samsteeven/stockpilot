import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * L'entreprise de la requête.
 *
 * PROVISOIRE (incrément 1, ADR-004) : lue dans l'en-tête X-Tenant-Id, sans authentification. L'incrément 2 la
 * tire du jeton de l'utilisateur, après vérification de son appartenance. La Row-Level Security, elle, est déjà
 * définitive : quelle que soit l'origine de l'identifiant, la base ne montre que les lignes de cette entreprise.
 */
export const CurrentTenant = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request>();
    const tenantId = request.header('x-tenant-id');
    if (!tenantId || !UUID.test(tenantId)) {
      throw new BadRequestException('En-tête X-Tenant-Id manquant ou invalide');
    }
    return tenantId;
  },
);
