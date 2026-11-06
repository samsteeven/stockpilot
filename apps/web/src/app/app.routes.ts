import type { Routes } from '@angular/router';
import { authenticated, requires } from './core/guards';
import { AuditPage } from './pages/audit';
import { LoginPage } from './pages/login';
import { OrderDetailPage } from './pages/order-detail';
import { OrdersPage } from './pages/orders';
import { ShellPage } from './pages/shell';
import { ShipmentsPage } from './pages/shipments';
import { StockPage } from './pages/stock';

export const routes: Routes = [
  { path: 'connexion', component: LoginPage, title: 'Connexion · StockPilot' },
  {
    path: '',
    component: ShellPage,
    canActivate: [authenticated],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'commandes' },
      { path: 'stock', component: StockPage, title: 'Stock · StockPilot' },
      {
        path: 'commandes',
        component: OrdersPage,
        title: 'Commandes · StockPilot',
      },
      {
        path: 'commandes/:id',
        component: OrderDetailPage,
        title: 'Commande · StockPilot',
      },
      {
        path: 'expeditions',
        component: ShipmentsPage,
        title: 'Expéditions · StockPilot',
      },
      {
        path: 'audit',
        component: AuditPage,
        canActivate: [requires('audit:read')],
        title: 'Journal · StockPilot',
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
