-- FINDING-006: ReviewService's overdue sweep filters ReviewTask on
-- status IN (pending, in_progress) AND dueDate < now together. The existing
-- single-column indexes on status and dueDate do not efficiently cover this
-- combined filter shape.
-- CreateIndex
CREATE INDEX "ReviewTask_status_dueDate_idx" ON "policytracker"."ReviewTask"("status", "dueDate");

-- FINDING-007: AcknowledgmentService.markOverdue's sweep filters
-- AcknowledgmentAssignment on status = pending AND dueDate < now together.
-- The existing single-column index on status does not efficiently cover
-- this combined filter shape.
-- CreateIndex
CREATE INDEX "AcknowledgmentAssignment_status_dueDate_idx" ON "policytracker"."AcknowledgmentAssignment"("status", "dueDate");

-- FINDING-008: AuditService.query() filters by `source` and a `createdAt`
-- range together (compliance/evidence-binder exports scoped to
-- system-generated events in a date window), then sorts newest-first.
-- Neither existing single-column index covers this combined filter+sort
-- shape.
-- CreateIndex
CREATE INDEX "AuditEvent_source_createdAt_idx" ON "policytracker"."AuditEvent"("source", "createdAt");
