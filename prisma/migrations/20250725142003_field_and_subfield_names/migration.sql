-- AlterTable
ALTER TABLE "CatalogField" ADD COLUMN "fieldName" TEXT;
ALTER TABLE "CatalogField" ADD COLUMN "subfieldNames" JSONB;
