-- Grace period for a shop that is over its plan's active-discount allowance.
-- Nullable and additive: no data is rewritten and no existing row changes
-- meaning, so this applies cleanly to the live database with nothing to undo.
-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "overLimitSince" TIMESTAMP(3);
