-- SSO cross-app return: allow-listed origin to hand tokens back to after login.
-- Additive and policytracker-only. No PolicyManager objects in public.

ALTER TABLE "policytracker"."OidcState"
  ADD COLUMN "returnTo" TEXT;
