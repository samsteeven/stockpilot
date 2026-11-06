import { createHmac } from 'node:crypto';
import { defineConfig } from 'cypress';

/**
 * Tests de bout en bout : le front (ng serve, proxy vers l'API), l'API et le worker construits, PostgreSQL et
 * Redis migrés et remplis par `npm run db:seed`. Le prestataire de paiement est joué par les tests : ils signent
 * leurs notifications avec le secret partagé, comme un vrai prestataire.
 */
export default defineConfig({
  e2e: {
    baseUrl: process.env['WEB_URL'] ?? 'http://localhost:4200',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    supportFile: 'cypress/support/e2e.ts',
    video: false,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 8_000,
    viewportWidth: 1280,
    viewportHeight: 800,
    // Valeurs publiques lues par les tests (Cypress.expose) ; le secret de paiement reste côté Node (tâche).
    expose: {
      apiUrl: process.env['API_URL'] ?? 'http://127.0.0.1:3000',
      // Facultatif : sans Mailpit, les messages sont vérifiés par l'API (/notifications).
      mailpitUrl: process.env['MAILPIT_URL'] ?? '',
    },
    setupNodeEvents(on) {
      on('task', {
        /** Signature d'une notification de paiement (HMAC-SHA256 de « horodatage.corps »). */
        signPayment(body: string): string {
          const secret = process.env['PAYMENT_WEBHOOK_SECRET'];
          if (!secret) throw new Error('PAYMENT_WEBHOOK_SECRET manquant');
          const timestamp = Math.floor(Date.now() / 1000);
          const mac = createHmac('sha256', secret)
            .update(`${timestamp}.${body}`)
            .digest('hex');
          return `t=${timestamp},v1=${mac}`;
        },
      });
    },
  },
});
