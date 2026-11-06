// Configuration Prisma : les migrations s'exécutent avec le rôle propriétaire (DATABASE_URL),
// l'application avec un rôle soumis à la Row-Level Security (APP_DATABASE_URL, voir libs/database).
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Absente à la génération du client (npm install, CI) : seules les migrations en ont besoin.
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://non-configure@localhost/stockpilot',
  },
});
