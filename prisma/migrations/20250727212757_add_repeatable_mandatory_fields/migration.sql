/*
  Warnings:

  - Added the required column `updatedAt` to the `CatalogField` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CatalogField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tag" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "subfields" JSONB NOT NULL,
    "fieldType" TEXT NOT NULL,
    "fieldName" TEXT,
    "subfieldNames" JSONB,
    "isRepeatable" BOOLEAN NOT NULL DEFAULT false,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "recordId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CatalogField_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "CatalogRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_CatalogField" ("fieldName", "fieldType", "id", "recordId", "subfieldNames", "subfields", "tag", "value") SELECT "fieldName", "fieldType", "id", "recordId", "subfieldNames", "subfields", "tag", "value" FROM "CatalogField";
DROP TABLE "CatalogField";
ALTER TABLE "new_CatalogField" RENAME TO "CatalogField";
CREATE INDEX "CatalogField_recordId_idx" ON "CatalogField"("recordId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
