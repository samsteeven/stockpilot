import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { authInterceptor } from './auth.interceptor';
import { Session } from './session';

const PROFILE = {
  userId: 'u1',
  email: 'demo@atelier-nova.example',
  tenants: [
    {
      tenantId: 't1',
      name: 'Atelier Nova',
      slug: 'atelier-nova',
      role: 'OWNER',
      permissions: ['orders:read'],
    },
  ],
};

describe('intercepteur d’accès', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let session: Session;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    session = TestBed.inject(Session);

    const login = session.login('demo@atelier-nova.example', 'x');
    backend
      .expectOne('/api/v1/auth/login')
      .flush({ accessToken: 'jeton-1', userId: 'u1' });
    await Promise.resolve();
    backend.expectOne('/api/v1/auth/me').flush(PROFILE);
    await login;
  });

  afterEach(() => backend.verify());

  it('ajoute le jeton et l’entreprise, pas sur les routes de session', async () => {
    const pending = firstValueFrom(http.get('/api/v1/orders'));
    const request = backend.expectOne('/api/v1/orders');
    expect(request.request.headers.get('Authorization')).toBe('Bearer jeton-1');
    expect(request.request.headers.get('X-Tenant-Id')).toBe('t1');
    request.flush([]);
    await pending;
  });

  it('trois requêtes qui expirent ensemble : un seul renouvellement, puis chacune est rejouée avec le nouveau jeton', async () => {
    const calls = [
      '/api/v1/orders',
      '/api/v1/shipments',
      '/api/v1/inventory',
    ].map((url) => firstValueFrom(http.get(url)));
    for (const url of [
      '/api/v1/orders',
      '/api/v1/shipments',
      '/api/v1/inventory',
    ]) {
      backend
        .expectOne(url)
        .flush(
          { title: 'Jeton expiré' },
          { status: 401, statusText: 'Unauthorized' },
        );
    }
    await Promise.resolve();
    const refresh = backend.expectOne('/api/v1/auth/refresh');
    expect(refresh.request.headers.get('X-Requested-With')).toBe('StockPilot');
    refresh.flush({ accessToken: 'jeton-2', userId: 'u1' });
    await new Promise((resolve) => setTimeout(resolve));

    for (const url of [
      '/api/v1/orders',
      '/api/v1/shipments',
      '/api/v1/inventory',
    ]) {
      const retried = backend.expectOne(url);
      expect(retried.request.headers.get('Authorization')).toBe(
        'Bearer jeton-2',
      );
      retried.flush([]);
    }
    await Promise.all(calls);
  });

  it('session perdue : retour à la connexion', async () => {
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true);
    const call = firstValueFrom(http.get('/api/v1/orders'));
    backend
      .expectOne('/api/v1/orders')
      .flush(null, { status: 401, statusText: 'Unauthorized' });
    await Promise.resolve();
    backend
      .expectOne('/api/v1/auth/refresh')
      .flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(call).rejects.toBeTruthy();
    expect(navigate).toHaveBeenCalledWith(['/connexion']);
    expect(session.authenticated()).toBe(false);
  });
});
