import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guards a route with the passport-jwt strategy.
 * Missing/invalid/expired token => 401 (handled by AuthGuard/passport).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
