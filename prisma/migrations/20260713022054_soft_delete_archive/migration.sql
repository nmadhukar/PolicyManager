-- AlterTable
ALTER TABLE "policytracker"."Document" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "preArchiveStatus" "policytracker"."DocumentStatus";

-- CreateIndex
CREATE INDEX "Document_deletedAt_idx" ON "policytracker"."Document"("deletedAt");

-- AddForeignKey
ALTER TABLE "policytracker"."Document" ADD CONSTRAINT "Document_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "policytracker"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
