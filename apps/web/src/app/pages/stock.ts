import { HttpClient } from '@angular/common/http';
import {
  Component,
  computed,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Catalog, type VariantOption } from '../core/catalog';
import { problemMessage } from '../core/guards';
import type { StockLevel, Warehouse } from '../core/models';

@Component({
  selector: 'app-stock',
  template: `
    <h1>Stock</h1>
    <label class="inline">
      Entrepôt
      <select
        (change)="select($any($event.target).value)"
        data-cy="warehouse-select"
      >
        @for (w of warehouses(); track w.id) {
          <option [value]="w.id" [selected]="w.id === warehouseId()">
            {{ w.code }} · {{ w.name }}
          </option>
        }
      </select>
    </label>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    <table data-cy="stock-table">
      <thead>
        <tr>
          <th>Article</th>
          <th>Référence</th>
          <th class="num">Physique</th>
          <th class="num">Réservé</th>
          <th class="num">Disponible</th>
        </tr>
      </thead>
      <tbody>
        @for (line of rows(); track line.stockItemId) {
          <tr [attr.data-cy]="'stock-' + line.sku">
            <td>{{ line.label }}</td>
            <td>
              <code>{{ line.sku }}</code>
            </td>
            <td class="num">{{ line.onHand }}</td>
            <td class="num">{{ line.reserved }}</td>
            <td
              class="num"
              [class.warn]="line.available === 0"
              data-cy="available"
            >
              {{ line.available }}
            </td>
          </tr>
        } @empty {
          <tr>
            <td colspan="5" class="muted">Aucun article dans cet entrepôt.</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class StockPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly catalog = inject(Catalog);

  readonly warehouses = signal<Warehouse[]>([]);
  readonly warehouseId = signal<string | null>(null);
  private readonly levels = signal<StockLevel[]>([]);
  private readonly variants = signal<VariantOption[]>([]);
  readonly error = signal<string | null>(null);

  readonly rows = computed(() => {
    const names = new Map(
      this.variants().map((v) => [v.id, `${v.productName} · ${v.name}`]),
    );
    return this.levels().map((l) => ({
      ...l,
      label: names.get(l.variantId) ?? l.sku,
    }));
  });

  async ngOnInit(): Promise<void> {
    try {
      const [warehouses, variants] = await Promise.all([
        this.catalog.warehouses(),
        this.catalog.variants(),
      ]);
      this.warehouses.set(warehouses);
      this.variants.set(variants);
      if (warehouses[0]) await this.select(warehouses[0].id);
    } catch (error) {
      this.error.set(problemMessage(error));
    }
  }

  async select(warehouseId: string): Promise<void> {
    this.warehouseId.set(warehouseId);
    try {
      this.levels.set(
        await firstValueFrom(
          this.http.get<StockLevel[]>('/api/v1/inventory', {
            params: { warehouseId },
          }),
        ),
      );
    } catch (error) {
      this.error.set(problemMessage(error));
    }
  }
}
