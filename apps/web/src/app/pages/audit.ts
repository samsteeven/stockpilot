import { DatePipe, JsonPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, type OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { problemMessage } from '../core/guards';
import type { AuditEntry } from '../core/models';

/** Journal d'audit de l'entreprise (propriétaire et administrateur). */
@Component({
  selector: 'app-audit',
  imports: [DatePipe, JsonPipe],
  template: `
    <h1>Journal d’audit</h1>
    <p class="muted">
      Écrit dans la transaction de chaque action ; la base refuse toute
      modification.
    </p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    <table data-cy="audit-table">
      <thead>
        <tr>
          <th>Quand</th>
          <th>Action</th>
          <th>Par</th>
          <th>Détails</th>
        </tr>
      </thead>
      <tbody>
        @for (e of entries(); track e.id) {
          <tr>
            <td>{{ e.createdAt | date: 'medium' }}</td>
            <td>
              <code data-cy="audit-action">{{ e.action }}</code>
            </td>
            <td>{{ e.actorId ? e.actorId.slice(0, 8) : 'système' }}</td>
            <td>
              <code class="details">{{ e.details | json }}</code>
            </td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class AuditPage implements OnInit {
  private readonly http = inject(HttpClient);
  readonly entries = signal<AuditEntry[]>([]);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.entries.set(
        await firstValueFrom(
          this.http.get<AuditEntry[]>('/api/v1/audit', {
            params: { limit: '100' },
          }),
        ),
      );
    } catch (error) {
      this.error.set(problemMessage(error));
    }
  }
}
