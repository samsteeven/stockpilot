-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'WAREHOUSE_MANAGER', 'OPERATOR', 'VIEWER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TenantRole" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("tenant_id","user_id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "tenant_memberships_user_id_idx" ON "tenant_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_idx" ON "invitations"("tenant_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================================================================
-- Règles garanties par la base (ajoutées à la migration générée par Prisma).
-- =====================================================================================================================

ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_lowercase" CHECK ("email" = lower("email"));

-- Contexte utilisateur, posé comme le contexte d'entreprise (set_config(…, true), local à la transaction).
CREATE FUNCTION "current_user_id"() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION "current_user_id"() TO stockpilot_runtime;

-- --- Droits du rôle applicatif ---------------------------------------------------------------------------------------
-- Comptes et sessions : globaux (une personne, plusieurs entreprises), pas soumis à la RLS d'entreprise.
GRANT SELECT, INSERT, UPDATE ON "users", "refresh_tokens" TO stockpilot_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_memberships" TO stockpilot_runtime;
GRANT SELECT, INSERT, UPDATE ON "invitations" TO stockpilot_runtime;

-- --- Adhésions ------------------------------------------------------------------------------------------------------
-- Lecture : l'entreprise du contexte voit ses membres, et une personne voit ses propres adhésions (liste de ses
-- entreprises). Écriture : seulement dans le contexte de l'entreprise ; une personne ne peut pas modifier sa propre
-- adhésion depuis son seul contexte utilisateur.
ALTER TABLE "tenant_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memberships_read" ON "tenant_memberships" FOR SELECT
  USING ("tenant_id" = "current_tenant_id"() OR "user_id" = "current_user_id"());
CREATE POLICY "memberships_insert" ON "tenant_memberships" FOR INSERT
  WITH CHECK ("tenant_id" = "current_tenant_id"());
CREATE POLICY "memberships_update" ON "tenant_memberships" FOR UPDATE
  USING ("tenant_id" = "current_tenant_id"()) WITH CHECK ("tenant_id" = "current_tenant_id"());
CREATE POLICY "memberships_delete" ON "tenant_memberships" FOR DELETE
  USING ("tenant_id" = "current_tenant_id"());

-- Une personne voit le nom des entreprises dont elle est membre (en plus de l'entreprise du contexte).
CREATE POLICY "tenants_of_member" ON "tenants" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "tenant_memberships" m WHERE m."tenant_id" = "tenants"."id" AND m."user_id" = "current_user_id"()
  ));

-- Toute entreprise garde au moins un propriétaire, quelle que soit la requête qui modifie les adhésions.
CREATE FUNCTION "tenant_keeps_an_owner"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "tenant_memberships" WHERE "tenant_id" = OLD."tenant_id" AND "role" = 'OWNER')
     AND EXISTS (SELECT 1 FROM "tenants" WHERE "id" = OLD."tenant_id") THEN
    RAISE EXCEPTION 'une entreprise garde au moins un propriétaire' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "tenant_memberships_keep_owner"
  AFTER UPDATE OR DELETE ON "tenant_memberships"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "tenant_keeps_an_owner"();

-- --- Invitations ----------------------------------------------------------------------------------------------------
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invitations" USING ("tenant_id" = "current_tenant_id"());

-- La personne invitée n'appartient pas encore à l'entreprise : elle ne voit pas ses invitations. Cette fonction
-- retrouve une invitation par l'empreinte de son jeton, et rien d'autre ; l'acceptation se fait ensuite dans le
-- contexte de l'entreprise.
CREATE FUNCTION "invitation_by_token_hash"("hash" text)
  RETURNS TABLE ("id" uuid, "tenant_id" uuid, "email" text, "role" "TenantRole", "expires_at" timestamptz,
                 "accepted_at" timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT "id", "tenant_id", "email", "role", "expires_at", "accepted_at" FROM "invitations" WHERE "token_hash" = "hash"
$$;
REVOKE ALL ON FUNCTION "invitation_by_token_hash"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "invitation_by_token_hash"(text) TO stockpilot_runtime;
