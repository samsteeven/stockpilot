import { Component, inject } from '@angular/core';
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { ROLE } from '../core/labels';
import { Session } from '../core/session';

/** Cadre des pages connectées : entreprise, rôle, navigation selon les permissions, déconnexion. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header>
      <strong class="brand">StockPilot</strong>
      @if (session.profile(); as profile) {
        @if (profile.tenants.length > 1) {
          <select
            aria-label="Entreprise"
            [value]="session.tenant()?.tenantId"
            (change)="switchTenant($any($event.target).value)"
            data-cy="tenant-select"
          >
            @for (t of profile.tenants; track t.tenantId) {
              <option [value]="t.tenantId">{{ t.name }}</option>
            }
          </select>
        } @else {
          <span data-cy="tenant-name">{{ session.tenant()?.name }}</span>
        }
        <span class="muted" data-cy="role">{{ roleLabel() }}</span>
        <nav>
          <a routerLink="/stock" routerLinkActive="active">Stock</a>
          <a routerLink="/commandes" routerLinkActive="active">Commandes</a>
          <a routerLink="/expeditions" routerLinkActive="active">Expéditions</a>
          @if (session.can('audit:read')) {
            <a routerLink="/audit" routerLinkActive="active" data-cy="nav-audit"
              >Journal</a
            >
          }
        </nav>
        <span class="spacer"></span>
        <span class="muted" data-cy="user-email">{{ profile.email }}</span>
        <button type="button" class="link" (click)="logout()" data-cy="logout">
          Déconnexion
        </button>
      }
    </header>
    <main>
      <router-outlet />
    </main>
  `,
})
export class ShellPage {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);

  roleLabel(): string {
    const role = this.session.tenant()?.role ?? '';
    return ROLE[role] ?? role;
  }

  switchTenant(tenantId: string): void {
    this.session.selectTenant(tenantId);
    // Recharge la page courante avec les données de l'autre entreprise.
    void this.router
      .navigateByUrl('/', { skipLocationChange: true })
      .then(() => this.router.navigate(['/commandes']));
  }

  async logout(): Promise<void> {
    await this.session.logout();
    await this.router.navigate(['/connexion']);
  }
}
