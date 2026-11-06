-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('READY_TO_SHIP', 'SHIPPED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'READY_TO_SHIP',
    "carrier" TEXT,
    "tracking_number" TEXT,
    "shipped_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipments_tenant_id_status_created_at_idx" ON "shipments"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenant_id_order_id_key" ON "shipments"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenant_id_id_key" ON "shipments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_created_at_idx" ON "notifications"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_event_id_template_key" ON "notifications"("event_id", "template");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================================================================
-- Règles garanties par la base (ajoutées à la migration générée par Prisma).
-- =====================================================================================================================

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_shipped_details" CHECK (
    "status" = 'READY_TO_SHIP'
    OR ("carrier" IS NOT NULL AND "tracking_number" IS NOT NULL AND "shipped_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "shipments_delivered_at" CHECK (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL));
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_sent_at" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL));

-- Une expédition n'avance que dans un sens : prête, expédiée, livrée. Pas de retour, pas de saut.
CREATE FUNCTION "shipments_forward_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'READY_TO_SHIP' AND NEW."status" = 'SHIPPED')
    OR (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED')
  ) THEN
    RAISE EXCEPTION 'expédition %: % vers % interdit', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "shipments_status_forward_only" BEFORE UPDATE ON "shipments"
  FOR EACH ROW EXECUTE FUNCTION "shipments_forward_only"();

-- --- Droits du rôle applicatif ---------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "shipments", "notifications" TO stockpilot_runtime;

-- --- Isolation entre entreprises -------------------------------------------------------------------------------------
ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shipments" USING ("tenant_id" = "current_tenant_id"());

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notifications" USING ("tenant_id" = "current_tenant_id"());
