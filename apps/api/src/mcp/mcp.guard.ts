import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ApiClientsService } from '../api-clients/api-clients.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthUser } from '@policymanager/shared';
import { McpService } from './mcp.service';
import type { McpIdentity } from './mcp.routes';

export type McpRequest = Request & { mcpIdentity?: McpIdentity };

@Injectable()
export class McpGuard implements CanActivate {
  constructor(private readonly mcp: McpService, private readonly jwt: JwtAuthGuard, private readonly clients: ApiClientsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.mcp.config.enabled) throw new NotFoundException();
    const req = context.switchToHttp().getRequest<McpRequest>();
    const origin = req.headers.origin;
    if (origin && !this.mcp.config.allowedOrigins.includes(origin)) throw new ForbiddenException('MCP Origin is not allowed');
    const authorization = req.headers.authorization;
    const apiKey = req.headers['x-api-key'];
    if (authorization && apiKey) throw new BadRequestException('Choose a user JWT or an API key, not both');
    if (apiKey) {
      if (typeof apiKey !== 'string') throw new UnauthorizedException();
      const client = await this.clients.authenticate(apiKey.trim());
      if (!client) throw new UnauthorizedException('Invalid API credentials');
      req.mcpIdentity = { kind: 'api', credential: apiKey.trim(), client };
    } else {
      // Reuse the same live Passport strategy as REST; never decode a JWT without verifying it.
      await this.jwt.canActivate(context);
      const credential = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
      if (!credential) throw new UnauthorizedException();
      req.mcpIdentity = { kind: 'user', credential, user: req.user as AuthUser };
    }
    return true;
  }
}
