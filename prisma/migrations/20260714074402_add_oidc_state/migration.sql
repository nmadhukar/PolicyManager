-- CreateTable
CREATE TABLE "OidcState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OidcState_state_key" ON "OidcState"("state");

-- CreateIndex
CREATE INDEX "OidcState_expiresAt_idx" ON "OidcState"("expiresAt");
