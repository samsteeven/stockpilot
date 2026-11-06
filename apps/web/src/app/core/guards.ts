import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import type { Permission, Problem } from './models';
import { Session } from './session';

/** Pages réservées aux personnes connectées ; au rechargement, la session est d'abord retrouvée. */
export const authenticated: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  try {
    return (await session.restore()) ? true : router.parseUrl('/connexion');
  } catch {
    // API injoignable : la page de connexion affichera l'erreur à la tentative suivante.
    return router.parseUrl('/connexion');
  }
};

/** Page réservée à une permission du rôle dans l'entreprise choisie. L'API vérifie de toute façon. */
export function requires(permission: Permission): CanActivateFn {
  return () => {
    const session = inject(Session);
    return session.can(permission) ? true : inject(Router).parseUrl('/');
  };
}

/** Message lisible à partir d'une erreur de l'API (Problem Details) ou du réseau. */
export function problemMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'API injoignable.';
    const problem = error.error as Problem | null;
    if (problem?.title) {
      return problem.detail
        ? `${problem.title} : ${problem.detail}`
        : problem.title;
    }
    return `Erreur ${error.status}`;
  }
  return 'Erreur inattendue.';
}
