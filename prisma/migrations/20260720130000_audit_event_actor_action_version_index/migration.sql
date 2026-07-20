-- FINDING-012: the "has this user viewed this version" check filters
-- AuditEvent on exactly (actorUserId, action, versionId) — used on the hot
-- path of every review-task completion (ReviewService.completeTask,
-- ReviewService.viewedVersionIds) and every acknowledgment
-- (AcknowledgmentService.acknowledge). AuditEvent is append-only and
-- ever-growing; the existing single-column indexes on documentId,
-- actorUserId, createdAt, and action do not efficiently cover this
-- three-column filter shape, and versionId has no index at all.
-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_action_versionId_idx" ON "policytracker"."AuditEvent"("actorUserId", "action", "versionId");
