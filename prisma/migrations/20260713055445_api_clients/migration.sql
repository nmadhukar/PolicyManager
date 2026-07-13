-- CreateTable
CREATE TABLE "policytracker"."ApiClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "allowedCategoryIds" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_clientId_key" ON "policytracker"."ApiClient"("clientId");

-- AddForeignKey
ALTER TABLE "policytracker"."ApiClient" ADD CONSTRAINT "ApiClient_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "policytracker"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
