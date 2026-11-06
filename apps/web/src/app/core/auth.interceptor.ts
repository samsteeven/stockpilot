import {
  HttpErrorResponse,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { Session } from './session';

/** Routes de session : elles ne portent pas le jeton d'accès et ne déclenchent pas de renouvellement. */
const SESSION_ROUTES = [
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
];

function withAccess(
  request: HttpRequest<unknown>,
  session: Session,
): HttpRequest<unknown> {
  const headers: Record<string, string> = {};
  const token = session.accessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const tenant = session.tenant();
  if (tenant) headers['X-Tenant-Id'] = tenant.tenantId;
  return request.clone({ setHeaders: headers });
}

/**
 * Ajoute le jeton d'accès et l'entreprise choisie aux appels de l'API. Un 401 (jeton expiré) déclenche un
 * renouvellement puis rejoue la requête une fois ; si la session est perdue, retour à la connexion.
 */
export const authInterceptor: HttpInterceptorFn = (
  request,
  next: HttpHandlerFn,
) => {
  if (
    !request.url.startsWith('/api/') ||
    SESSION_ROUTES.includes(request.url)
  ) {
    return next(request);
  }
  const session = inject(Session);
  const router = inject(Router);
  return next(withAccess(request, session)).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }
      return from(session.refresh()).pipe(
        switchMap((renewed) => {
          if (!renewed) {
            void router.navigate(['/connexion']);
            return throwError(() => error);
          }
          return next(withAccess(request, session));
        }),
      );
    }),
  );
};
