import { BadRequestException } from '@nestjs/common';
import { validatePassword } from '@policymanager/shared';

/**
 * Server-side authoritative password-policy gate. Throws 400 with the concrete
 * violations so the UI can render them. The rule set lives in `@policymanager/shared`
 * so client hints and server enforcement never drift.
 */
export function assertPasswordPolicy(password: string): void {
  const errors = validatePassword(password);
  if (errors.length > 0) {
    throw new BadRequestException({ message: 'Password does not meet the policy.', errors });
  }
}
