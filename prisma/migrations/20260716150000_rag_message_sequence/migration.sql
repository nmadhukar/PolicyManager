-- RAG: stable per-turn message ordering.
-- `createMany` binds one `now()` to every row in the batch, so a conversation's
-- user + assistant turn can share the same createdAt and sort unpredictably.
-- This sequence is a real DB identity column, so insertion order is preserved
-- even for rows created in the same statement.

CREATE SEQUENCE "policytracker"."RagMessage_sequence_seq";

ALTER TABLE "policytracker"."RagMessage"
  ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT nextval('"policytracker"."RagMessage_sequence_seq"');

ALTER SEQUENCE "policytracker"."RagMessage_sequence_seq"
  OWNED BY "policytracker"."RagMessage"."sequence";

DROP INDEX "policytracker"."RagMessage_conversationId_createdAt_idx";

CREATE INDEX "RagMessage_conversationId_sequence_idx"
  ON "policytracker"."RagMessage"("conversationId", "sequence");
