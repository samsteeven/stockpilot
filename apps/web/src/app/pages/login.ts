import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { problemMessage } from '../core/guards';
import { Session } from '../core/session';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <main class="login">
      <h1>StockPilot</h1>
      <p class="muted">Stocks, commandes et expéditions</p>
      <form (ngSubmit)="submit()" data-cy="login-form">
        <label>
          E-mail
          <input
            name="email"
            type="email"
            autocomplete="username"
            required
            [(ngModel)]="email"
            data-cy="email"
          />
        </label>
        <label>
          Mot de passe
          <input
            name="password"
            type="password"
            autocomplete="current-password"
            required
            [(ngModel)]="password"
            data-cy="password"
          />
        </label>
        @if (error()) {
          <p class="error" role="alert" data-cy="login-error">{{ error() }}</p>
        }
        <button type="submit" [disabled]="busy()" data-cy="login-submit">
          Se connecter
        </button>
      </form>
    </main>
  `,
})
export class LoginPage {
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  email = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.login(this.email.trim(), this.password);
      await this.router.navigate(['/']);
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse && error.status === 401
          ? 'E-mail ou mot de passe incorrect.'
          : problemMessage(error),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
