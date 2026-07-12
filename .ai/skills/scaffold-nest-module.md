# Skill: Scaffold Nest Module

## Purpose

Create a NestJS module with consistent controller, service, DTO, and test structure.

## Use When

- Scaffold mode is approved.
- Adding a new backend feature module.

## Procedure

1. Confirm scaffold/implementation mode is approved.
2. Define module responsibility.
3. Create module, controller, service, DTOs, and tests.
4. Keep controllers thin and services business-focused.
5. Add validation pipes/DTO validation.
6. Add RBAC guard where route is protected.
7. Add audit hook where document data is accessed.
8. Update developer docs.

## Stop Conditions

Stop if app scaffold is not approved or repo root is not isolated.
