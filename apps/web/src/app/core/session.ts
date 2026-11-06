import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Membership, Permission, Profile, SessionTokens } from './models';

/** En-tête exigé par l'API sur les routes qui lisent le cookie de session (protection CSRF). */
export const CSRF_HEADER = { 'X-Requested-With': 'StockPilot' };

const TENANT_KEY = 'stockpilot.tenant';

/**
 * Session de l'utilisateur.
 *
 * Le jeton d'accès (15 min) reste en mémoire, jamais dans le stockage du navigateur. Le jeton de renouvellement
 * est dans un cookie HttpOnly que le JavaScript ne voit pas : au rechargement de la page, la session est
 * retrouvée par un renouvellement. Les renouvellements sont sérialisés : deux requêtes qui reçoivent un 401 au
 * même moment n'en déclenchent qu'un (l'API traiterait le second comme un vol et couperait la session).
 */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly http = inject(HttpClient);

  private readonly token = signal<string | null>(null);
  readonly profile = signal<Profile | null>(null);
  private readonly tenantId = signal<string | null>(null);
  private refreshing: Promise<boolean> | null = null;
  private restored: Promise<boolean> | null = null;

  readonly authenticated = computed(() => this.profile() !== null);
  readonly tenant = computed<Membership | null>(() => {
    const profile = this.profile();
    if (!profile) return null;
    return (
      profile.tenants.find((t) => t.tenantId === this.tenantId()) ??
      profile.tenants[0] ??
      null
    );
  });

  accessToken(): string | null {
    return this.token();
  }

  can(permission: Permission): boolean {
    return this.tenant()?.permissions.includes(permission) ?? false;
  }

  /** Au démarrage : une session existe-t-elle (cookie de renouvellement valide) ? Une seule tentative. */
  restore(): Promise<boolean> {
    // Échec réseau : la promesse n'est pas gardée, la prochaine navigation réessaiera.
    this.restored ??= this.refresh().catch((error: unknown) => {
      this.restored = null;
      throw error;
    });
    return this.restored;
  }

  async login(email: string, password: string): Promise<void> {
    const tokens = await firstValueFrom(
      this.http.post<SessionTokens>('/api/v1/auth/login', { email, password }),
    );
    this.token.set(tokens.accessToken);
    await this.loadProfile();
    this.restored = Promise.resolve(true);
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post('/api/v1/auth/logout', {}, { headers: CSRF_HEADER }),
      );
    } catch {
      // Session déjà expirée côté serveur : on oublie quand même l'état local.
    }
    this.clear();
  }

  /** Renouvelle le jeton d'accès ; un seul renouvellement à la fois, partagé par tous les appelants. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(
      () => (this.refreshing = null),
    );
    return this.refreshing;
  }

  selectTenant(tenantId: string): void {
    this.tenantId.set(tenantId);
    try {
      localStorage.setItem(TENANT_KEY, tenantId);
    } catch {
      // Stockage indisponible (navigation privée) : le choix vaut pour cet onglet seulement.
    }
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const tokens = await firstValueFrom(
        this.http.post<SessionTokens>(
          '/api/v1/auth/refresh',
          {},
          { headers: CSRF_HEADER },
        ),
      );
      this.token.set(tokens.accessToken);
      if (!this.profile()) await this.loadProfile();
      return true;
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.clear();
        return false;
      }
      throw error;
    }
  }

  private async loadProfile(): Promise<void> {
    const profile = await firstValueFrom(
      this.http.get<Profile>('/api/v1/auth/me'),
    );
    this.profile.set(profile);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(TENANT_KEY);
    } catch {
      saved = null;
    }
    const known = profile.tenants.some((t) => t.tenantId === saved);
    this.tenantId.set(known ? saved : (profile.tenants[0]?.tenantId ?? null));
  }

  private clear(): void {
    this.token.set(null);
    this.profile.set(null);
    this.restored = Promise.resolve(false);
  }
}
