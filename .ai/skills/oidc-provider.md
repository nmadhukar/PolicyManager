# Skill: OIDC Provider

## Purpose

Wire a new OIDC provider into the pluggable auth system.

## Procedure

Use `.ai/skills/oidc-auth.md`.

Provider-specific work must include:

- Env configuration.
- Callback URL.
- Issuer and audience validation.
- JIT provisioning behavior.
- Group-to-role mapping.
- Negative tests.
- Admin/developer docs.
