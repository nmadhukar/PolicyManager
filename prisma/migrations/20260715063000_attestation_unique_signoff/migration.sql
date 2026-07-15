-- One sign-off per (document, version, user, action): a user can approve,
-- review, or acknowledge a given version only once.
-- CreateIndex
CREATE UNIQUE INDEX "Attestation_documentId_versionId_userId_action_key" ON "policytracker"."Attestation"("documentId", "versionId", "userId", "action");
