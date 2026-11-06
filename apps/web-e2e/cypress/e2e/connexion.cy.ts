import { OWNER } from '../support/e2e';

describe('Connexion et session', () => {
  it('mauvais mot de passe : message clair, on reste sur la page', () => {
    cy.visit('/connexion');
    cy.get('[data-cy=email]').type(OWNER);
    cy.get('[data-cy=password]').type('pas-le-bon-mot-de-passe');
    cy.get('[data-cy=login-submit]').click();
    cy.get('[data-cy=login-error]').should(
      'contain',
      'E-mail ou mot de passe incorrect',
    );
    cy.location('pathname').should('eq', '/connexion');
  });

  it('une page protégée renvoie à la connexion', () => {
    cy.visit('/stock');
    cy.location('pathname').should('eq', '/connexion');
  });

  it('connecté, la session survit au rechargement (cookie de renouvellement), puis la déconnexion la ferme', () => {
    cy.login(OWNER);
    cy.get('[data-cy=tenant-name]').should('contain.text', 'Atelier Nova');
    cy.get('[data-cy=role]').should('contain.text', 'Propriétaire');

    cy.getCookie('stockpilot_refresh').should(
      'have.property',
      'httpOnly',
      true,
    );
    // Le jeton d'accès n'est stocké nulle part dans le navigateur.
    cy.window().then((win) => {
      const stored =
        JSON.stringify({ ...win.localStorage }) +
        JSON.stringify({ ...win.sessionStorage });
      expect(stored).not.to.contain('eyJ');
    });

    cy.reload();
    cy.get('[data-cy=user-email]').should('contain.text', OWNER);

    cy.get('[data-cy=logout]').click();
    cy.location('pathname').should('eq', '/connexion');
    cy.visit('/commandes');
    cy.location('pathname').should('eq', '/connexion');
  });

  it('le jeton expiré est renouvelé sans que la personne le voie', () => {
    cy.login(OWNER);
    // Le premier appel aux commandes répond 401, comme avec un jeton expiré : le front renouvelle et rejoue.
    let first = true;
    cy.intercept('GET', '/api/v1/orders*', (req) => {
      if (first) {
        first = false;
        req.reply({ statusCode: 401, body: { title: 'Jeton expiré' } });
      }
    }).as('orders');
    cy.intercept('POST', '/api/v1/auth/refresh').as('refresh');
    cy.visit('/stock');
    cy.get('a[href="/commandes"]').click();
    cy.wait('@refresh').its('response.statusCode').should('eq', 200);
    cy.get('[data-cy=orders-table]').should('be.visible');
    cy.location('pathname').should('eq', '/commandes');
  });
});
