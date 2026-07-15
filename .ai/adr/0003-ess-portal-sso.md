# ADR 0003 — Azure AD SSO login from ESS Portal

Status: Accepted

## Context

ESS Portal is an internal employee launchpad that already authenticates its users
against Azure AD / Microsoft Entra (Authorization Code + PKCE, no local passwords).
ESS Portal serves a single company — there is no multi-tenant requirement here.

PolicyManager today authenticates users with local email + Argon2 password only.
OIDC/SSO was already planned as a pluggable auth path (`PLAN.md` "Authentication"
section) with a `UserIdentity` model scaffolded in `prisma/schema.prisma` but unused,
and ticket PM-0209 ("Design OIDC implementation ADR") open in the Phase 2 backlog.
This ADR resolves PM-0209.

Requirement: a user already logged into ESS Portal should be able to click a
PolicyManager launchpad tile and land inside PolicyManager already authenticated,
with no second password prompt and no manual account setup.

ESS Portal and PolicyManager have separate PostgreSQL databases with no shared
storage, no shared session store, and no existing code path where either app is
aware of the other.

## Decision

Add Azure AD OIDC login to PolicyManager as a second, parallel auth path alongside
the existing local login. Do **not** build any direct trust relationship between
ESS Portal and PolicyManager (no shared secret, no token handoff endpoint). Both
apps independently trust Azure AD as the shared identity authority; PolicyManager
never calls ESS Portal and ESS Portal never calls PolicyManager.

PolicyManager remains single-tenant — no `Tenant` model, no change to `User.email`
global uniqueness. This deployment serves one company, matching ESS Portal's own
scope.

### Flow

1. ESS Portal's PolicyManager launchpad tile links to
   `GET /auth/oidc/login` on PolicyManager instead of PolicyManager's plain
   homepage.
2. PolicyManager redirects the browser to Azure AD's `/authorize` endpoint
   (Authorization Code + PKCE, `state` + `nonce` for CSRF/replay protection).
3. Azure AD's existing browser SSO session (established when the user logged into
   ESS Portal) authorizes silently — no re-prompt, unless the org's conditional
   access policy forces step-up (e.g. MFA).
4. Azure AD redirects back to `GET /auth/oidc/callback` with an authorization code.
   PolicyManager exchanges it for tokens and validates the ID token (issuer,
   audience, nonce, expiry).
5. JIT provisioning / account linking, in order:
   - Look up `UserIdentity` by `(provider='azure', subject=<Azure oid claim>)`.
     Found → log in as that `User`.
   - Else look up `User` by `email` (from the ID token's `email` claim). Found →
     create a `UserIdentity` row linking this Azure subject to the existing user
     (only when the email claim is verified — do not silently take over an
     account on an unverified claim).
   - Else create a new `User` + `UserIdentity` in one transaction.
6. Every newly-provisioned user is assigned the **Staff** role by default. No
   Azure AD group → role mapping in this iteration (see Consequences); no
   automatic Admin assignment ever.
7. PolicyManager issues its own JWT access + refresh pair — the same shape and
   the same `issueTokens()` path local login already uses, so downstream guards,
   RBAC, and audit logging stay auth-source-agnostic.
8. PolicyManager redirects the browser to its own frontend with the access token
   in a URL fragment (`/auth/callback#accessToken=...`), not a query string or
   JSON body, so the token never lands in server logs or `Referer` headers. A new
   `AuthCallbackPage` parses the fragment, scrubs the URL, stores the token in
   memory (matching PolicyManager's existing in-memory access-token handling),
   and fetches `GET /auth/me`.

### Local login

Existing email/password login is kept, unrestricted in this iteration — it
remains available as a break-glass path if Azure AD has an outage. Restricting it
to a specific admin-only role is deferred (see Consequences).

## Consequences

Positive:

- No new trust surface between ESS Portal and PolicyManager — nothing to secure,
  rotate, or audit beyond PolicyManager's own Azure AD app registration.
- Completes already-scoped work (`UserIdentity` model, `.ai/skills/oidc-auth.md`
  procedure) rather than introducing a new mechanism.
- ESS Portal requires no auth backend changes — only its launchpad tile URL
  changes.
- Downstream RBAC/audit code is unaffected — OIDC and local login converge on the
  same internal JWT shape.

Negative:

- Every first-time SSO user lands as Staff regardless of their actual job
  function; an admin must manually promote people via the existing role-management
  UI until group→role mapping is added. This is an explicit, temporary gap, not an
  oversight.
- Local login staying unrestricted means PolicyManager is not yet fully
  Azure-AD-enforced — anyone with a valid local password can still bypass SSO.
  Acceptable for this iteration; revisit if that becomes a compliance concern.
- No single sign-out — signing out of ESS Portal does not sign the user out of
  PolicyManager. Out of scope for this ADR.
- No automated de-provisioning — removing a user from Azure AD does not disable
  their PolicyManager account. Out of scope for this ADR.

## Alternatives Considered

- **App-to-app token handoff** (ESS Portal mints a signed token PolicyManager
  verifies directly) — rejected. Requires a new trust relationship (shared secret
  or JWKS exchange, new endpoints on both sides) that doesn't exist today, for no
  benefit over federating through the identity provider both apps already trust.
- **Multi-tenant PolicyManager** — rejected for this iteration. ESS Portal serves
  one company; adding a `Tenant` model and changing `User.email` uniqueness would
  be a breaking schema change with no current requirement driving it.
- **Azure AD group → role mapping in v1** — deferred, not rejected. Requires
  confirming actual Azure AD group names with whoever owns the compliance program;
  shipping with a safe default (Staff) unblocks the login flow now without
  waiting on that org decision.

## Verification

- Unit/integration tests per `.ai/skills/oidc-auth.md` "Required Tests": first SSO
  login creates `User` + `UserIdentity`; existing `User` (matched by email) links
  only when the email claim is verified; a second login with the same Azure
  subject reuses the existing account rather than creating a duplicate; disabled
  provider (`OIDC_ENABLED=false`) cannot be used.
- Manual end-to-end check: click the PolicyManager tile from a logged-in ESS
  Portal session and confirm no login screen appears.
- Manual check: local email/password login still succeeds after OIDC is enabled.

## Documentation Impact

- `.env.example` — uncomment and document the `OIDC_*` Azure block.
- Admin/developer docs — describe the default-Staff behavior for new SSO users
  and how to promote them, since there is no group mapping yet.
- Update `.ai/tasks/BACKLOG.md` — mark PM-0209 resolved by this ADR; add a
  follow-up ticket for Azure AD group → role mapping once group names are
  confirmed.
