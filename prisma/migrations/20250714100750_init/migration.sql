/*
  Warnings:

  - Added the required column `recordTemplateId` to the `CatalogRecord` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CatalogRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateName" TEXT NOT NULL,
    "templateDesc" TEXT,
    "recordTemplateId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CatalogRecord" ("createdAt", "id", "templateDesc", "templateName", "updatedAt") SELECT "createdAt", "id", "templateDesc", "templateName", "updatedAt" FROM "CatalogRecord";
DROP TABLE "CatalogRecord";
ALTER TABLE "new_CatalogRecord" RENAME TO "CatalogRecord";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
