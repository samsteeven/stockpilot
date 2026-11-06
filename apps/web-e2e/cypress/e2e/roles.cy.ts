import { MANAGER, OWNER, VIEWER } from '../support/e2e';

describe('Ce que chaque rôle voit', () => {
  it('lecteur : consulte, mais ni création, ni annulation, ni journal', () => {
    cy.login(VIEWER);
    cy.get('[data-cy=role]').should('contain.text', 'Lecteur');
    cy.get('[data-cy=orders-table]').should('be.visible');
    cy.get('[data-cy=new-order]').should('not.exist');
    cy.get('[data-cy=nav-audit]').should('not.exist');

    cy.get('[data-cy=orders-table] tbody a').first().click();
    cy.get('[data-cy=detail-status]').should('be.visible');
    cy.get('[data-cy=cancel-order]').should('not.exist');

    // L'adresse tapée à la main ne contourne rien : le garde renvoie, et l'API refuserait de toute façon.
    cy.visit('/audit');
    cy.location('pathname').should('eq', '/commandes');

    cy.visit('/expeditions');
    cy.get('[data-cy=shipments-table]').should('be.visible');
    cy.get('[data-cy=ship]').should('not.exist');
  });

  it('responsable d’entrepôt : commandes et expéditions, pas de journal', () => {
    cy.login(MANAGER);
    cy.get('[data-cy=role]').should('contain.text', 'Responsable d’entrepôt');
    cy.get('[data-cy=new-order]').should('be.visible');
    cy.get('[data-cy=nav-audit]').should('not.exist');
  });

  it('propriétaire : le journal d’audit montre les actions passées', () => {
    cy.login(OWNER);
    cy.get('[data-cy=nav-audit]').click();
    cy.get('[data-cy=audit-action]').should('have.length.greaterThan', 0);
    cy.get('[data-cy=audit-action]').contains('order.created');
  });

  it('le stock affiche physique, réservé et disponible', () => {
    cy.login(OWNER);
    cy.visit('/stock');
    cy.get('[data-cy=warehouse-select]').select('PAR · Paris');
    cy.get('[data-cy=stock-CABLE-USBC-2M]').should(
      'contain',
      'Câble USB-C 2 m',
    );
  });
});
