-- FINDING-011: DocumentAcl.add() was idempotent only via an application-level
-- findFirst-then-create check, with no DB constraint backing it. Two concurrent
-- add-grant requests for the same principal+permission could both pass the
-- check and commit, producing duplicate rows. Add partial unique indexes so the
-- database is the source of truth for the grant's uniqueness, matching the
-- existing partial-unique pattern used for Document.documentNumber and
-- DocumentCategory root names (see 20260713120000_data_integrity_hardening).
--
-- documentId and categoryId are mutually exclusive scopes (a grant is either
-- on a specific document or on a whole category), so two separate partial
-- indexes are needed rather than one compound unique across all four columns.

-- Dedup pre-existing document-scoped grants before the index can be created,
-- keeping the oldest row (createdAt) per (documentId, principalType,
-- principalId, permission) and removing any later duplicates.
DELETE FROM "policytracker"."DocumentAcl" a
USING "policytracker"."DocumentAcl" b
WHERE a."documentId" IS NOT NULL
  AND a."documentId" = b."documentId"
  AND a."principalType" = b."principalType"
  AND a."principalId" = b."principalId"
  AND a."permission" = b."permission"
  AND (a."createdAt", a."id") > (b."createdAt", b."id");

-- Dedup pre-existing category-scoped grants the same way.
DELETE FROM "policytracker"."DocumentAcl" a
USING "policytracker"."DocumentAcl" b
WHERE a."categoryId" IS NOT NULL
  AND a."categoryId" = b."categoryId"
  AND a."principalType" = b."principalType"
  AND a."principalId" = b."principalId"
  AND a."permission" = b."permission"
  AND (a."createdAt", a."id") > (b."createdAt", b."id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAcl_document_grant_key"
  ON "policytracker"."DocumentAcl" ("documentId", "principalType", "principalId", "permission")
  WHERE "documentId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAcl_category_grant_key"
  ON "policytracker"."DocumentAcl" ("categoryId", "principalType", "principalId", "permission")
  WHERE "categoryId" IS NOT NULL;
