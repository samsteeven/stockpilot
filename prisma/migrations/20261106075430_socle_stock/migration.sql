-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'SALE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "quantity_reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "reservation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reference_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenant_id_code_key" ON "warehouses"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenant_id_id_key" ON "warehouses"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "products_tenant_id_active_idx" ON "products"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_sku_key" ON "products"("tenant_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_sku_key" ON "product_variants"("tenant_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_id_key" ON "product_variants"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "stock_items_tenant_id_variant_id_idx" ON "stock_items"("tenant_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenant_id_warehouse_id_variant_id_key" ON "stock_items"("tenant_id", "warehouse_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenant_id_id_key" ON "stock_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "reservations_status_expires_at_idx" ON "reservations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenant_id_reference_key" ON "reservations"("tenant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenant_id_id_key" ON "reservations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_items_reservation_id_stock_item_id_key" ON "reservation_items"("reservation_id", "stock_item_id");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_stock_item_id_created_at_idx" ON "stock_movements"("tenant_id", "stock_item_id", "created_at");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_items" ADD CONSTRAINT "reservation_items_tenant_id_reservation_id_fkey" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_items" ADD CONSTRAINT "reservation_items_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================================================================
-- Règles garanties par la base elle-même (ajoutées à la migration générée par Prisma).
-- =====================================================================================================================

-- --- Quantités : invariants 1 et 2 (jamais négatif, jamais plus réservé que le physique) ---------------------------
ALTER TABLE "stock_items"
  ADD CONSTRAINT "stock_items_on_hand_non_negative" CHECK ("quantity_on_hand" >= 0),
  ADD CONSTRAINT "stock_items_reserved_non_negative" CHECK ("quantity_reserved" >= 0),
  ADD CONSTRAINT "stock_items_reserved_within_on_hand" CHECK ("quantity_reserved" <= "quantity_on_hand");

ALTER TABLE "reservation_items"
  ADD CONSTRAINT "reservation_items_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_quantity_not_zero" CHECK ("quantity" <> 0);

-- Un état final porte sa date, un état actif n'en a pas.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_status_dates" CHECK (
    ("status" = 'ACTIVE' AND "confirmed_at" IS NULL AND "ended_at" IS NULL)
    OR ("status" = 'CONFIRMED' AND "confirmed_at" IS NOT NULL)
    OR ("status" IN ('RELEASED', 'EXPIRED') AND "ended_at" IS NOT NULL)
  );

-- --- Mouvements immuables : invariant 5 (on corrige par un mouvement compensatoire) ---------------------------------
CREATE FUNCTION "stock_movements_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'un mouvement de stock est immuable : enregistrer un mouvement compensatoire'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "stock_movements_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_immutable"();

-- --- Rôle applicatif ------------------------------------------------------------------------------------------------
-- L'application se connecte avec un membre de stockpilot_runtime : ni propriétaire des tables, ni BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockpilot_runtime') THEN
    CREATE ROLE stockpilot_runtime NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO stockpilot_runtime;
GRANT SELECT, INSERT, UPDATE ON "tenants", "warehouses", "products", "product_variants", "stock_items",
  "reservations", "reservation_items" TO stockpilot_runtime;
-- Mouvements : ajout et lecture seulement, même pour l'application.
GRANT SELECT, INSERT ON "stock_movements" TO stockpilot_runtime;

-- --- Row-Level Security : invariant 6 -------------------------------------------------------------------------------
-- Le contexte est posé par transaction (set_config('app.tenant_id', …, true)) : il disparaît au COMMIT et ne peut
-- pas rester sur une connexion du pool. Sans contexte, current_setting renvoie NULL : aucune ligne visible.
CREATE FUNCTION "current_tenant_id"() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenants" USING ("id" = "current_tenant_id"());

ALTER TABLE "warehouses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "warehouses" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "products" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_variants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "product_variants" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "stock_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_items" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reservations" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "reservation_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reservation_items" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_movements" USING ("tenant_id" = "current_tenant_id"());

-- --- Balayage des réservations expirées -----------------------------------------------------------------------------
-- Le filet de sécurité du worker doit trouver les réservations expirées de toutes les entreprises, alors que la RLS
-- les lui cache. Cette fonction, exécutée avec les droits de son propriétaire, ne révèle que le strict nécessaire
-- (identifiant et entreprise) ; l'expiration elle-même se fait ensuite dans le contexte de l'entreprise.
CREATE FUNCTION "expired_reservations"("batch" integer)
  RETURNS TABLE ("reservation_id" uuid, "tenant_id" uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT "id", "tenant_id" FROM "reservations"
  WHERE "status" = 'ACTIVE' AND "expires_at" <= now()
  ORDER BY "expires_at"
  LIMIT LEAST("batch", 1000)
$$;

REVOKE ALL ON FUNCTION "expired_reservations"(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "expired_reservations"(integer) TO stockpilot_runtime;
GRANT EXECUTE ON FUNCTION "current_tenant_id"() TO stockpilot_runtime;
