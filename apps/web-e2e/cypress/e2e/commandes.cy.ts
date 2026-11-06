import { CABLE, MANAGER, OWNER, PARIS, TENANT } from '../support/e2e';

/** Disponible du câble USB-C à Paris, lu par l'API. */
function cableAvailable(token: string): Cypress.Chainable<number> {
  return cy
    .request({
      url: `${Cypress.expose('apiUrl')}/api/v1/inventory?warehouseId=${PARIS}`,
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT },
    })
    .then(
      (response) =>
        (response.body as { variantId: string; available: number }[]).find(
          (l) => l.variantId === CABLE,
        )!.available,
    );
}

/** Crée une commande de câbles par le formulaire et rend son identifiant (lu dans l'adresse). */
function orderCables(
  quantity: number,
  email?: string,
): Cypress.Chainable<string> {
  cy.visit('/commandes');
  cy.get('[data-cy=new-order]').click();
  cy.get('[data-cy=order-warehouse]').select('PAR · Paris');
  cy.get('[data-cy=order-variant]').select('Câble USB-C 2 m · 2 m (12.50 EUR)');
  cy.get('[data-cy=order-quantity]').clear().type(String(quantity));
  if (email) cy.get('[data-cy=order-email]').type(email);
  cy.get('[data-cy=order-estimate]').should(
    'contain.text',
    `${(12.5 * quantity).toFixed(2)} EUR`,
  );
  cy.get('[data-cy=order-submit]').click();
  cy.location('pathname').should('match', /^\/commandes\/[0-9a-f-]{36}$/);
  return cy.location('pathname').then((path) => path.split('/').pop()!);
}

describe('Commandes', () => {
  it('créer une commande réserve le stock ; l’annuler le rend', () => {
    cy.apiToken(OWNER).then((token) => {
      cableAvailable(token).then((before) => {
        cy.login(OWNER);
        orderCables(2);
        cy.get('[data-cy=detail-status]').should(
          'contain.text',
          'En attente de paiement',
        );
        cy.get('[data-cy=detail-total]').should('contain.text', '25.00 EUR');
        cy.get('[data-cy=payment-status]').should('contain.text', 'Attendu');
        cableAvailable(token).should('eq', before - 2);

        cy.get('[data-cy=cancel-order]').click();
        cy.get('[data-cy=detail-status]').should('contain.text', 'Annulée');
        cy.get('[data-cy=cancel-reason]').should(
          'contain',
          'annulée par un membre',
        );
        cy.get('[data-cy=cancel-order]').should('not.exist');
        cableAvailable(token).should('eq', before);
      });
    });
  });

  it('un double clic sur « Commander » ne crée qu’une commande (Idempotency-Key)', () => {
    cy.login(OWNER);
    cy.intercept('POST', '/api/v1/orders').as('create');
    cy.visit('/commandes');
    cy.get('[data-cy=new-order]').click();
    cy.get('[data-cy=order-quantity]').clear().type('1');
    // Deux soumissions coup sur coup, avant que le bouton ne se désactive.
    cy.get('[data-cy=order-form]').then(($form) => {
      $form[0].dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true }),
      );
      $form[0].dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true }),
      );
    });
    cy.wait('@create').then((first) => {
      cy.wait('@create').then((second) => {
        const key = first.request.headers['idempotency-key'];
        expect(key).to.be.a('string');
        expect(second.request.headers['idempotency-key']).to.eq(key);
        expect(second.response?.body.id).to.eq(first.response?.body.id);
      });
    });
  });

  it('stock insuffisant : message de l’API, aucune commande', () => {
    cy.login(OWNER);
    cy.visit('/commandes');
    cy.get('[data-cy=new-order]').click();
    cy.get('[data-cy=order-quantity]').clear().type('99999');
    cy.get('[data-cy=order-submit]').click();
    cy.get('[data-cy=order-error]').should('contain', 'Stock insuffisant');
    cy.location('pathname').should('eq', '/commandes');
  });

  it('parcours complet : payée, expédiée par l’entrepôt, le client est prévenu', () => {
    const email = `client-${Date.now()}@example.com`;
    cy.login(OWNER);
    orderCables(1, email).then((orderId) => {
      cy.apiToken(OWNER).then((token) => {
        const headers = {
          authorization: `Bearer ${token}`,
          'x-tenant-id': TENANT,
        };
        cy.request({
          url: `${Cypress.expose('apiUrl')}/api/v1/orders/${orderId}`,
          headers,
        })
          .its('body')
          .then((order) => cy.pay(order))
          .should('eq', 'confirmed');

        cy.reload();
        cy.get('[data-cy=detail-status]').should('contain.text', 'Confirmée');
        cy.get('[data-cy=payment-status]').should('contain.text', 'Reçu');
        // L'expédition est créée par le worker (événement de l'outbox) : on attend qu'elle apparaisse.
        cy.get('[data-cy=shipment-status]', { timeout: 20_000 }).should(
          'contain.text',
          'À expédier',
        );

        cy.get('[data-cy=logout]').click();
        cy.login(MANAGER);
        cy.visit('/expeditions');
        cy.get(`[data-cy=shipment-${orderId}]`).within(() => {
          cy.get('[data-cy=carrier]').type('Colissimo');
          cy.get('[data-cy=tracking]').type('6A1234567890');
          cy.get('[data-cy=ship]').click();
          cy.get('[data-cy=shipment-status]').should(
            'contain.text',
            'Expédiée',
          );
          cy.get('[data-cy=deliver]').click();
          cy.get('[data-cy=shipment-status]').should('contain.text', 'Livrée');
        });

        // Messages au client : confirmée, expédiée, livrée (envoyés par le worker).
        const sent = () =>
          cy
            .request({
              url: `${Cypress.expose('apiUrl')}/api/v1/notifications?limit=200`,
              headers,
            })
            .its('body')
            .then(
              (
                rows: { recipient: string; template: string; status: string }[],
              ) =>
                rows
                  .filter((r) => r.recipient === email && r.status === 'SENT')
                  .map((r) => r.template)
                  .sort(),
            );
        const expected = [
          'order-confirmed',
          'shipment-delivered',
          'shipment-shipped',
        ];
        const waitForMails = (attempt = 0): void => {
          sent().then((templates) => {
            if (templates.length < expected.length && attempt < 30) {
              cy.wait(500);
              waitForMails(attempt + 1);
            } else {
              expect(templates).to.deep.eq(expected);
            }
          });
        };
        waitForMails();

        const mailpit = Cypress.expose('mailpitUrl') as string;
        if (mailpit) {
          cy.request(
            `${mailpit}/api/v1/search?query=to:${encodeURIComponent(email)}`,
          )
            .its('body.messages')
            .should('have.length', 3);
        }
      });
    });
  });
});
