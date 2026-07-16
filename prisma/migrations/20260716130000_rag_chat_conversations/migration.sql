-- RAG Phase 4: chat conversation storage (ADR-0002).
-- Additive and policytracker-only. No PolicyManager objects in public.

CREATE TYPE "policytracker"."RagMessageRole" AS ENUM ('user', 'assistant');

CREATE TABLE "policytracker"."RagConversation" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "title"     TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RagConversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RagConversation_userId_updatedAt_idx"
  ON "policytracker"."RagConversation"("userId", "updatedAt");

CREATE TABLE "policytracker"."RagMessage" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "role"           "policytracker"."RagMessageRole" NOT NULL,
  "content"        TEXT NOT NULL,
  "citations"      JSONB,
  "grounded"       BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RagMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RagMessage_conversationId_createdAt_idx"
  ON "policytracker"."RagMessage"("conversationId", "createdAt");

ALTER TABLE "policytracker"."RagConversation"
  ADD CONSTRAINT "RagConversation_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "policytracker"."User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."RagMessage"
  ADD CONSTRAINT "RagMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId")
  REFERENCES "policytracker"."RagConversation"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
