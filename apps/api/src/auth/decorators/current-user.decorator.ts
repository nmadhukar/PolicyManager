import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '@policymanager/shared';

/**
 * Injects the authenticated AuthUser (populated by JwtStrategy.validate) into a
 * controller handler. Only meaningful on routes protected by JwtAuthGuard.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthUser;
  },
);
