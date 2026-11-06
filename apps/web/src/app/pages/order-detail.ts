import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Catalog, type VariantOption } from '../core/catalog';
import { problemMessage } from '../core/guards';
import {
  CANCEL_REASON,
  ORDER_STATUS,
  PAYMENT_STATUS,
  SHIPMENT_STATUS,
  shortRef,
} from '../core/labels';
import type { Order } from '../core/models';
import { Session } from '../core/session';

@Component({
  selector: 'app-order-detail',
  imports: [RouterLink, DatePipe],
  template: `
    <p><a routerLink="/commandes">← Commandes</a></p>
    @if (error()) {
      <p class="error" role="alert" data-cy="detail-error">{{ error() }}</p>
    }
    @if (order(); as o) {
      <div class="title-row">
        <h1>
          Commande <span data-cy="order-ref">{{ ref(o.id) }}</span>
        </h1>
        <span
          class="badge"
          [attr.data-status]="o.status"
          data-cy="detail-status"
          >{{ status(o.status) }}</span
        >
      </div>
      @if (o.cancelReason) {
        <p data-cy="cancel-reason">Annulée : {{ reason(o.cancelReason) }}</p>
      }
      <section class="grid">
        <div class="card">
          <h2>Articles</h2>
          <table>
            <tbody>
              @for (item of o.items; track item.variantId) {
                <tr>
                  <td>{{ variantName(item.variantId) }}</td>
                  <td class="num">
                    {{ item.quantity }} × {{ item.unitPrice }}
                  </td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th class="num" data-cy="detail-total">
                  {{ o.totalAmount }} {{ o.currency }}
                </th>
              </tr>
            </tfoot>
          </table>
          @if (o.customerEmail) {
            <p class="muted">Client : {{ o.customerEmail }}</p>
          }
        </div>
        <div class="card">
          <h2>Paiement</h2>
          @if (o.payment; as p) {
            <p data-cy="payment-status">{{ paymentLabel(p.status) }}</p>
            <p class="muted">
              Référence prestataire :
              <code data-cy="payment-reference">{{ p.providerReference }}</code>
            </p>
          }
          <h2>Expédition</h2>
          @if (o.shipment; as s) {
            <p data-cy="shipment-status">{{ shipmentLabel(s.status) }}</p>
            @if (s.trackingNumber) {
              <p>
                {{ s.carrier }} · <code>{{ s.trackingNumber }}</code>
              </p>
            }
          } @else {
            <p class="muted">Créée à la confirmation du paiement.</p>
          }
        </div>
      </section>
      <h2>Historique</h2>
      <ol data-cy="history">
        @for (h of o.history ?? []; track $index) {
          <li>
            {{ h.at | date: 'medium' }} : {{ status(h.to)
            }}{{ h.reason ? ' (' + reason(h.reason) + ')' : '' }}
          </li>
        }
      </ol>
      @if (o.status === 'PENDING_PAYMENT' && session.can('orders:write')) {
        <button
          type="button"
          class="danger"
          [disabled]="busy()"
          (click)="cancel()"
          data-cy="cancel-order"
        >
          Annuler la commande
        </button>
      }
    }
  `,
})
export class OrderDetailPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly catalog = inject(Catalog);
  protected readonly session = inject(Session);
  private readonly destroyRef = inject(DestroyRef);

  /** Paramètre de route (withComponentInputBinding). */
  readonly id = input.required<string>();
  readonly order = signal<Order | null>(null);
  private readonly variants = signal<VariantOption[]>([]);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  private readonly names = computed(
    () =>
      new Map(
        this.variants().map((v) => [v.id, `${v.productName} · ${v.name}`]),
      ),
  );

  ref = shortRef;

  async ngOnInit(): Promise<void> {
    try {
      const [order, variants] = await Promise.all([
        this.fetch(),
        this.catalog.variants(),
      ]);
      this.order.set(order);
      this.variants.set(variants);
    } catch (error) {
      this.error.set(problemMessage(error));
    }
    // Le paiement et l'expédition arrivent d'ailleurs (prestataire, worker) : tant que la commande attend
    // quelque chose, la page se met à jour toute seule.
    const timer = setInterval(() => void this.poll(), 3_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  private async poll(): Promise<void> {
    const current = this.order();
    const waiting =
      current &&
      (current.status === 'PENDING_PAYMENT' ||
        (current.status === 'CONFIRMED' &&
          current.shipment?.status !== 'DELIVERED'));
    if (!waiting || this.busy()) return;
    try {
      this.order.set(await this.fetch());
    } catch {
      // Erreur passagère : le prochain passage réessaiera.
    }
  }

  variantName(id: string): string {
    return this.names().get(id) ?? id;
  }

  status(value: string): string {
    return ORDER_STATUS[value] ?? value;
  }

  reason(value: string): string {
    return CANCEL_REASON[value] ?? value;
  }

  paymentLabel(value: string): string {
    return PAYMENT_STATUS[value] ?? value;
  }

  shipmentLabel(value: string): string {
    return SHIPMENT_STATUS[value] ?? value;
  }

  async cancel(): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(
        this.http.post(`/api/v1/orders/${this.id()}/cancel`, {}),
      );
      this.order.set(await this.fetch());
      this.error.set(null);
    } catch (error) {
      this.error.set(problemMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  private fetch(): Promise<Order> {
    return firstValueFrom(this.http.get<Order>(`/api/v1/orders/${this.id()}`));
  }
}
