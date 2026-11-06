import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Product, Variant, Warehouse } from './models';

export interface VariantOption extends Variant {
  productName: string;
}

/** Entrepôts et articles de l'entreprise choisie (listes courtes, lues à la demande). */
@Injectable({ providedIn: 'root' })
export class Catalog {
  private readonly http = inject(HttpClient);

  warehouses(): Promise<Warehouse[]> {
    return firstValueFrom(this.http.get<Warehouse[]>('/api/v1/warehouses'));
  }

  async variants(): Promise<VariantOption[]> {
    const options: VariantOption[] = [];
    let cursor: string | undefined;
    do {
      const query: Record<string, string> = { limit: '200' };
      if (cursor) query['cursor'] = cursor;
      const page = await firstValueFrom(
        this.http.get<{ items: Product[]; nextCursor?: string }>(
          '/api/v1/products',
          {
            params: query,
          },
        ),
      );
      for (const product of page.items)
        for (const variant of product.variants)
          options.push({ ...variant, productName: product.name });
      cursor = page.nextCursor;
    } while (cursor);
    return options;
  }
}
