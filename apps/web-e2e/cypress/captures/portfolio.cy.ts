// Captures d'écran pour la documentation et le portfolio, sur des données produites par les démonstrations
// (scripts/demo-commande.mjs puis scripts/demo-concurrence.mjs). Hors de la suite de tests :
//   npx cypress run --config specPattern=cypress/captures/*.cy.ts
import { MANAGER, OWNER } from '../support/e2e';

const shot = (name: string) =>
  cy.screenshot(name, { capture: 'viewport', overwrite: true });

describe('captures', () => {
  // Taille fixe, plus petite que la fenêtre de Cypress : pas de barres de défilement sur les captures.
  beforeEach(() => cy.viewport(1260, 700));

  it('expéditions : le responsable d’entrepôt expédie une commande payée', () => {
    cy.login(MANAGER);
    cy.visit('/expeditions');
    cy.get('[data-cy=shipments-table] tbody tr').should(
      'have.length.greaterThan',
      0,
    );
    // Expéditions déjà livrables avant ce clic : une de plus doit apparaître, celle que l'on expédie.
    cy.get('body').then(($body) => {
      const before = $body.find('[data-cy=deliver]').length;
      cy.get('[data-cy=carrier]').first().type('Colissimo');
      cy.get('[data-cy=tracking]').first().type('6A20261106FR');
      cy.get('[data-cy=ship]').first().click();
      cy.get('[data-cy=deliver]').should('have.length', before + 1);
    });
    shot('stockpilot-expeditions');
  });

  it('commandes, détail, nouvelle commande, stock et journal', () => {
    cy.login(OWNER);
    cy.visit('/commandes');
    cy.get('[data-cy=orders-table] tbody tr').should(
      'have.length.greaterThan',
      2,
    );
    shot('stockpilot-commandes');

    cy.contains('[data-cy=order-status]', 'Confirmée')
      .parents('tr')
      .find('a')
      .first()
      .click();
    cy.get('[data-cy=shipment-status]').should('be.visible');
    shot('stockpilot-commande');

    cy.visit('/commandes');
    cy.get('[data-cy=new-order]').click();
    cy.get('[data-cy=order-variant]').select(
      'Casque à réduction de bruit · Blanc (129.90 EUR)',
    );
    cy.get('[data-cy=order-quantity]').clear().type('2');
    cy.get('[data-cy=order-email]').type('client@exemple.fr');
    cy.get('[data-cy=order-estimate]').should('contain.text', '259.80');
    cy.get('[data-cy=order-email]').blur();
    cy.scrollTo('top');
    shot('stockpilot-nouvelle-commande');

    cy.visit('/stock');
    cy.get('[data-cy=stock-CASQUE-ANC-NOIR]').should('be.visible');
    shot('stockpilot-stock');

    cy.visit('/audit');
    cy.get('[data-cy=audit-action]').should('have.length.greaterThan', 3);
    shot('stockpilot-journal');
  });
});
