-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUND_REQUIRED');

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
ADD COLUMN     "unit_price" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" CHAR(3) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "customer_email" TEXT,
    "reservation_id" UUID,
    "created_by" UUID NOT NULL,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "reason" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_messages" (
    "consumer" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("consumer","message_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_tenant_id_status_created_at_idx" ON "orders"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_id_key" ON "orders"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_variant_id_key" ON "order_items"("order_id", "variant_id");

-- CreateIndex
CREATE INDEX "order_status_history_order_id_created_at_idx" ON "order_status_history"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_reference_key" ON "payments"("provider_reference");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "outbox_events_occurred_at_idx" ON "outbox_events"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================================================================
-- Règles garanties par la base (ajoutées à la migration générée par Prisma).
-- =====================================================================================================================

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_price_non_negative" CHECK ("unit_price" >= 0),
  ADD CONSTRAINT "product_variants_currency_code" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_non_negative" CHECK ("total_amount" >= 0),
  ADD CONSTRAINT "orders_currency_code" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "orders_cancel_reason" CHECK (("status" = 'CANCELLED') = ("cancel_reason" IS NOT NULL));
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_items_price_non_negative" CHECK ("unit_price" >= 0);
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_non_negative" CHECK ("amount" >= 0),
  ADD CONSTRAINT "payments_settled" CHECK (("status" = 'PENDING') = ("settled_at" IS NULL));

-- Une commande ne quitte « en attente de paiement » qu'une fois : confirmée ou annulée, elle ne change plus.
CREATE FUNCTION "orders_final_status"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING_PAYMENT' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'commande %: statut final %', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "orders_status_is_final" BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION "orders_final_status"();

-- Un paiement réglé (réussi, refusé ou à rembourser) ne change plus.
CREATE FUNCTION "payments_final_status"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'paiement %: statut final %', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payments_status_is_final" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "payments_final_status"();

-- Historique des statuts et journal d'audit : ajout seulement, même pour le propriétaire des tables.
CREATE FUNCTION "append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% : ajout seulement, ni modification ni suppression', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "order_status_history_append_only" BEFORE UPDATE OR DELETE ON "order_status_history"
  FOR EACH ROW EXECUTE FUNCTION "append_only"();
CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "append_only"();

-- --- Droits du rôle applicatif ---------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "orders", "payments" TO stockpilot_runtime;
GRANT SELECT, INSERT ON "order_items", "order_status_history", "idempotency_keys", "audit_logs" TO stockpilot_runtime;
GRANT SELECT, INSERT ON "processed_messages" TO stockpilot_runtime;
-- L'outbox ne se lit pas directement : l'application y écrit, le worker la parcourt par les fonctions ci-dessous.
GRANT INSERT ON "outbox_events" TO stockpilot_runtime;

-- --- Isolation entre entreprises -------------------------------------------------------------------------------------
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "orders" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order_items" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "order_status_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_status_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order_status_history" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payments" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "idempotency_keys" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_logs" USING ("tenant_id" = "current_tenant_id"());

-- Un événement est écrit dans le contexte de son entreprise (ou sans entreprise pour un événement global).
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_insert" ON "outbox_events" FOR INSERT
  WITH CHECK ("tenant_id" IS NULL OR "tenant_id" = "current_tenant_id"());

-- --- Fonctions réservées au worker et au retour du prestataire -------------------------------------------------------
-- Prend un lot d'événements non publiés, verrouillés jusqu'à la fin de la transaction de l'appelant : deux
-- publicateurs simultanés se partagent les lignes au lieu de publier deux fois les mêmes.
CREATE FUNCTION "claim_outbox_events"("batch" integer)
  RETURNS TABLE ("id" uuid, "tenant_id" uuid, "type" text, "payload" jsonb, "correlation_id" text,
                 "occurred_at" timestamptz, "attempts" integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT o."id", o."tenant_id", o."type", o."payload", o."correlation_id", o."occurred_at", o."attempts"
  FROM "outbox_events" o WHERE o."published_at" IS NULL
  ORDER BY o."occurred_at", o."id" LIMIT "batch"
  FOR UPDATE SKIP LOCKED
$$;
CREATE FUNCTION "mark_outbox_published"("ids" uuid[]) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE "outbox_events" SET "published_at" = now() WHERE "id" = ANY("ids") AND "published_at" IS NULL
$$;
CREATE FUNCTION "mark_outbox_failed"("event_id" uuid, "error" text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE "outbox_events" SET "attempts" = "attempts" + 1, "last_error" = left("error", 1000) WHERE "id" = "event_id"
$$;
-- Le prestataire de paiement ne connaît que sa référence : on retrouve l'entreprise et la commande, et rien d'autre.
CREATE FUNCTION "payment_by_provider_reference"("reference" text)
  RETURNS TABLE ("id" uuid, "tenant_id" uuid, "order_id" uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p."id", p."tenant_id", p."order_id" FROM "payments" p WHERE p."provider_reference" = "reference"
$$;
REVOKE ALL ON FUNCTION "claim_outbox_events"(integer), "mark_outbox_published"(uuid[]),
  "mark_outbox_failed"(uuid, text), "payment_by_provider_reference"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "claim_outbox_events"(integer), "mark_outbox_published"(uuid[]),
  "mark_outbox_failed"(uuid, text), "payment_by_provider_reference"(text) TO stockpilot_runtime;
