-- CreateTable
CREATE TABLE "CatalogRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateName" TEXT NOT NULL,
    "templateDesc" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CatalogField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tag" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "subfields" JSONB NOT NULL,
    "fieldType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    CONSTRAINT "CatalogField_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "CatalogRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CatalogField_recordId_idx" ON "CatalogField"("recordId");
