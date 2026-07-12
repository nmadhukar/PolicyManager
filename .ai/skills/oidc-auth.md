# Skill: OIDC Auth Integration

## Purpose

Add pluggable SSO without making the identity provider the authorization system.

## Use When

- Designing or implementing OIDC/SSO.
- Adding provider configuration.
- Adding JIT provisioning.
- Adding group-to-role mapping.

## Procedure

1. Keep internal RBAC as source of authorization.
2. Add provider config via env.
3. Use Authorization Code with PKCE.
4. Validate issuer, audience, nonce, and callback URL.
5. Create or link `UserIdentity`.
6. Map verified group claims to internal roles.
7. Issue app JWT.
8. Add tests with mock OIDC provider.

## Required Tests

- First SSO login creates user and identity.
- Existing email links only when verified and allowed.
- Group mapping assigns expected role.
- Missing group gives default safe role or denies access.
- Disabled provider cannot be used.

## Output

- Provider config.
- JIT/linking behavior.
- Role mapping proof.
- Auth tests.
