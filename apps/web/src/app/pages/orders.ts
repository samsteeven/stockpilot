import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  computed,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Catalog, type VariantOption } from '../core/catalog';
import { problemMessage } from '../core/guards';
import {
  CANCEL_REASON,
  ORDER_STATUS,
  PAYMENT_STATUS,
  shortRef,
} from '../core/labels';
import type { Order, OrderStatus, Warehouse } from '../core/models';
import { Session } from '../core/session';

interface Line {
  variantId: string;
  quantity: number;
}

@Component({
  selector: 'app-orders',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    <div class="title-row">
      <h1>Commandes</h1>
      @if (session.can('orders:write') && !creating()) {
        <button type="button" (click)="startCreating()" data-cy="new-order">
          Nouvelle commande
        </button>
      }
    </div>

    @if (creating()) {
      <form class="card" (ngSubmit)="submit()" data-cy="order-form">
        <h2>Nouvelle commande</h2>
        <label>
          Entrepôt
          <select
            name="warehouse"
            [(ngModel)]="warehouseId"
            required
            data-cy="order-warehouse"
          >
            @for (w of warehouses(); track w.id) {
              <option [value]="w.id">{{ w.code }} · {{ w.name }}</option>
            }
          </select>
        </label>
        @for (line of lines(); track $index) {
          <div class="line">
            <select
              [name]="'variant' + $index"
              [(ngModel)]="line.variantId"
              required
              (ngModelChange)="touch()"
              data-cy="order-variant"
            >
              @for (v of variants(); track v.id) {
                <option [value]="v.id">
                  {{ v.productName }} · {{ v.name }} ({{ v.unitPrice }}
                  {{ v.currency }})
                </option>
              }
            </select>
            <input
              [name]="'quantity' + $index"
              type="number"
              min="1"
              [(ngModel)]="line.quantity"
              (ngModelChange)="touch()"
              required
              aria-label="Quantité"
              data-cy="order-quantity"
            />
            @if (lines().length > 1) {
              <button type="button" class="link" (click)="removeLine($index)">
                Retirer
              </button>
            }
          </div>
        }
        <button type="button" class="link" (click)="addLine()">
          + Ajouter un article
        </button>
        <label>
          E-mail du client (facultatif)
          <input
            name="customerEmail"
            type="email"
            [(ngModel)]="customerEmail"
            data-cy="order-email"
          />
        </label>
        <p>
          Total estimé :
          <strong data-cy="order-estimate">{{ estimate() }}</strong>
          <span class="muted">(prix confirmé par le serveur)</span>
        </p>
        @if (formError()) {
          <p class="error" role="alert" data-cy="order-error">
            {{ formError() }}
          </p>
        }
        <div class="actions">
          <button type="submit" [disabled]="busy()" data-cy="order-submit">
            Commander
          </button>
          <button type="button" class="link" (click)="creating.set(false)">
            Fermer
          </button>
        </div>
      </form>
    }

    <label class="inline">
      Statut
      <select
        (change)="filter($any($event.target).value)"
        data-cy="status-filter"
      >
        <option value="">Tous</option>
        <option value="PENDING_PAYMENT">En attente de paiement</option>
        <option value="CONFIRMED">Confirmées</option>
        <option value="CANCELLED">Annulées</option>
      </select>
    </label>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    <table data-cy="orders-table">
      <thead>
        <tr>
          <th>Commande</th>
          <th>Créée</th>
          <th>Statut</th>
          <th>Paiement</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>
        @for (order of orders(); track order.id) {
          <tr [attr.data-cy]="'order-' + order.id">
            <td>
              <a [routerLink]="['/commandes', order.id]">{{ ref(order.id) }}</a>
            </td>
            <td>{{ order.createdAt | date: 'short' }}</td>
            <td>
              <span
                class="badge"
                [attr.data-status]="order.status"
                data-cy="order-status"
                >{{ statusLabel(order) }}</span
              >
            </td>
            <td>{{ paymentLabel(order) }}</td>
            <td class="num">{{ order.totalAmount }} {{ order.currency }}</td>
          </tr>
        } @empty {
          <tr>
            <td colspan="5" class="muted">Aucune commande.</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class OrdersPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly catalog = inject(Catalog);
  private readonly router = inject(Router);
  protected readonly session = inject(Session);

  readonly orders = signal<Order[]>([]);
  readonly error = signal<string | null>(null);
  private status: OrderStatus | '' = '';

  readonly creating = signal(false);
  readonly warehouses = signal<Warehouse[]>([]);
  readonly variants = signal<VariantOption[]>([]);
  readonly lines = signal<Line[]>([]);
  private readonly version = signal(0);
  warehouseId = '';
  customerEmail = '';
  readonly busy = signal(false);
  readonly formError = signal<string | null>(null);
  /**
   * Clé d'idempotence du formulaire : la même tant que la commande n'a pas réussi. Un double clic ou un nouvel
   * essai après une coupure réseau ne crée pas deux commandes.
   */
  private idempotencyKey = crypto.randomUUID();

  readonly estimate = computed(() => {
    this.version();
    const prices = new Map(this.variants().map((v) => [v.id, v]));
    let cents = 0;
    let currency = '';
    for (const line of this.lines()) {
      const variant = prices.get(line.variantId);
      if (!variant) continue;
      cents +=
        Math.round(Number(variant.unitPrice) * 100) *
        Number(line.quantity || 0);
      currency = variant.currency;
    }
    return `${(cents / 100).toFixed(2)} ${currency}`;
  });

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  ref = shortRef;

  statusLabel(order: Order): string {
    const label = ORDER_STATUS[order.status] ?? order.status;
    return order.cancelReason
      ? `${label} (${CANCEL_REASON[order.cancelReason] ?? order.cancelReason})`
      : label;
  }

  paymentLabel(order: Order): string {
    return order.payment
      ? (PAYMENT_STATUS[order.payment.status] ?? order.payment.status)
      : '';
  }

  async filter(status: OrderStatus | ''): Promise<void> {
    this.status = status;
    await this.load();
  }

  async startCreating(): Promise<void> {
    this.creating.set(true);
    this.formError.set(null);
    try {
      const [warehouses, variants] = await Promise.all([
        this.catalog.warehouses(),
        this.catalog.variants(),
      ]);
      this.warehouses.set(warehouses);
      this.variants.set(variants);
      this.warehouseId ||= warehouses[0]?.id ?? '';
      if (this.lines().length === 0)
        this.lines.set([{ variantId: variants[0]?.id ?? '', quantity: 1 }]);
    } catch (error) {
      this.formError.set(problemMessage(error));
    }
  }

  touch(): void {
    this.version.update((v) => v + 1);
  }

  addLine(): void {
    this.lines.update((lines) => [
      ...lines,
      { variantId: this.variants()[0]?.id ?? '', quantity: 1 },
    ]);
  }

  removeLine(index: number): void {
    this.lines.update((lines) => lines.filter((_, i) => i !== index));
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.formError.set(null);
    try {
      const order = await firstValueFrom(
        this.http.post<Order>(
          '/api/v1/orders',
          {
            warehouseId: this.warehouseId,
            items: this.lines().map((l) => ({
              variantId: l.variantId,
              quantity: Number(l.quantity),
            })),
            ...(this.customerEmail.trim()
              ? { customerEmail: this.customerEmail.trim() }
              : {}),
          },
          { headers: { 'Idempotency-Key': this.idempotencyKey } },
        ),
      );
      this.idempotencyKey = crypto.randomUUID();
      this.lines.set([]);
      this.customerEmail = '';
      this.creating.set(false);
      await this.router.navigate(['/commandes', order.id]);
    } catch (error) {
      this.formError.set(problemMessage(error));
      // Refusée par l'API (stock insuffisant…) : rien n'a été créé, la prochaine tentative prend une clé neuve.
      // Erreur réseau : la commande a peut-être été créée ; on garde la clé pour que le nouvel essai la retrouve.
      if (
        error instanceof HttpErrorResponse &&
        error.status >= 400 &&
        error.status < 500
      ) {
        this.idempotencyKey = crypto.randomUUID();
      }
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      const params: Record<string, string> = this.status
        ? { status: this.status }
        : {};
      this.orders.set(
        await firstValueFrom(
          this.http.get<Order[]>('/api/v1/orders', { params }),
        ),
      );
      this.error.set(null);
    } catch (error) {
      this.error.set(problemMessage(error));
    }
  }
}
