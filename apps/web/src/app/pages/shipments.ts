import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, type OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { problemMessage } from '../core/guards';
import { SHIPMENT_STATUS, shortRef } from '../core/labels';
import type { Shipment, ShipmentStatus } from '../core/models';
import { Session } from '../core/session';

@Component({
  selector: 'app-shipments',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    <h1>Expéditions</h1>
    <label class="inline">
      Statut
      <select
        (change)="filter($any($event.target).value)"
        data-cy="shipment-filter"
      >
        <option value="">Toutes</option>
        <option value="READY_TO_SHIP">À expédier</option>
        <option value="SHIPPED">Expédiées</option>
        <option value="DELIVERED">Livrées</option>
      </select>
    </label>
    @if (error()) {
      <p class="error" role="alert" data-cy="shipment-error">{{ error() }}</p>
    }
    <table data-cy="shipments-table">
      <thead>
        <tr>
          <th>Commande</th>
          <th>Créée</th>
          <th>Statut</th>
          <th>Suivi</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        @for (s of shipments(); track s.id) {
          <tr [attr.data-cy]="'shipment-' + s.orderId">
            <td>
              <a [routerLink]="['/commandes', s.orderId]">{{
                ref(s.orderId)
              }}</a>
            </td>
            <td>{{ s.createdAt | date: 'short' }}</td>
            <td>
              <span
                class="badge"
                [attr.data-status]="s.status"
                data-cy="shipment-status"
                >{{ label(s.status) }}</span
              >
            </td>
            <td>
              @if (s.trackingNumber) {
                {{ s.carrier }} · <code>{{ s.trackingNumber }}</code>
              }
            </td>
            <td>
              @if (session.can('shipments:write')) {
                @if (s.status === 'READY_TO_SHIP') {
                  <form
                    class="inline-form"
                    (ngSubmit)="ship(s, carrier.value, tracking.value)"
                  >
                    <input
                      #carrier
                      placeholder="Transporteur"
                      required
                      aria-label="Transporteur"
                      data-cy="carrier"
                    />
                    <input
                      #tracking
                      placeholder="N° de suivi"
                      required
                      aria-label="Numéro de suivi"
                      data-cy="tracking"
                    />
                    <button type="submit" data-cy="ship">Expédier</button>
                  </form>
                } @else if (s.status === 'SHIPPED') {
                  <button type="button" (click)="deliver(s)" data-cy="deliver">
                    Marquer livrée
                  </button>
                }
              }
            </td>
          </tr>
        } @empty {
          <tr>
            <td colspan="5" class="muted">
              Aucune expédition. Elles sont créées à la confirmation du
              paiement.
            </td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class ShipmentsPage implements OnInit {
  private readonly http = inject(HttpClient);
  protected readonly session = inject(Session);

  readonly shipments = signal<Shipment[]>([]);
  readonly error = signal<string | null>(null);
  private status: ShipmentStatus | '' = '';

  ref = shortRef;

  label(status: string): string {
    return SHIPMENT_STATUS[status] ?? status;
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async filter(status: ShipmentStatus | ''): Promise<void> {
    this.status = status;
    await this.load();
  }

  async ship(
    shipment: Shipment,
    carrier: string,
    trackingNumber: string,
  ): Promise<void> {
    await this.act(() =>
      firstValueFrom(
        this.http.post(`/api/v1/shipments/${shipment.id}/ship`, {
          carrier: carrier.trim(),
          trackingNumber: trackingNumber.trim(),
        }),
      ),
    );
  }

  async deliver(shipment: Shipment): Promise<void> {
    await this.act(() =>
      firstValueFrom(
        this.http.post(`/api/v1/shipments/${shipment.id}/deliver`, {}),
      ),
    );
  }

  private async act(request: () => Promise<unknown>): Promise<void> {
    try {
      await request();
      this.error.set(null);
    } catch (error) {
      this.error.set(problemMessage(error));
    }
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const params: Record<string, string> = this.status
        ? { status: this.status }
        : {};
      this.shipments.set(
        await firstValueFrom(
          this.http.get<Shipment[]>('/api/v1/shipments', { params }),
        ),
      );
    } catch (error) {
      this.error.set(problemMessage(error));
    }
  }
}
