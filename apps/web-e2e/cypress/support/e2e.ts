/** Comptes et données de `npm run db:seed` (Atelier Nova). */
export const PASSWORD = 'demonstration-stockpilot';
export const OWNER = 'demo@atelier-nova.example';
export const MANAGER = 'entrepot@atelier-nova.example';
export const VIEWER = 'lecture@atelier-nova.example';
export const TENANT = '0a1e5c3e-5b7a-4c1e-9f00-000000000001';
export const PARIS = '0a1e5c3e-5b7a-4c1e-9f00-0000000000a1';
export const CABLE = '0a1e5c3e-5b7a-4c1e-9f00-0000000000c3';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /** Connexion par le formulaire, comme une personne. */
      login(email: string): Chainable<void>;
      /** Jeton d'accès obtenu directement auprès de l'API (préparation de données). */
      apiToken(email: string): Chainable<string>;
      /** Notification signée du prestataire de paiement pour une commande. */
      pay(
        order: PaymentTarget,
        type?: 'payment.succeeded' | 'payment.failed',
      ): Chainable<string>;
    }
  }
}

export interface PaymentTarget {
  payment: { providerReference: string; amount: string; currency: string };
}

Cypress.Commands.add('login', (email: string) => {
  cy.visit('/connexion');
  cy.get('[data-cy=email]').type(email);
  cy.get('[data-cy=password]').type(PASSWORD, { log: false });
  cy.get('[data-cy=login-submit]').click();
  cy.location('pathname').should('eq', '/commandes');
  cy.get('[data-cy=user-email]').should('have.text', email);
});

Cypress.Commands.add('apiToken', (email: string) =>
  cy
    .request('POST', `${Cypress.expose('apiUrl')}/api/v1/auth/login`, {
      email,
      password: PASSWORD,
    })
    .its('body.accessToken'),
);

Cypress.Commands.add(
  'pay',
  (order: PaymentTarget, type = 'payment.succeeded') => {
    const body = JSON.stringify({
      id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type,
      data: {
        providerReference: order.payment.providerReference,
        amount: order.payment.amount,
        currency: order.payment.currency,
      },
    });
    return cy.task<string>('signPayment', body).then((signature) =>
      cy
        .request({
          method: 'POST',
          url: `${Cypress.expose('apiUrl')}/api/v1/payments/webhook`,
          headers: {
            'content-type': 'application/json',
            'stockpilot-signature': signature,
          },
          body,
        })
        .its('body.outcome'),
    );
  },
);
