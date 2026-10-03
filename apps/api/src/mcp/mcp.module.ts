import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiClientsModule } from '../api-clients/api-clients.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { McpController } from './mcp.controller';
import { McpGuard } from './mcp.guard';
import { McpService } from './mcp.service';

@Module({ imports: [AuthModule, ApiClientsModule], controllers: [McpController], providers: [JwtAuthGuard, McpGuard, McpService], exports: [McpService] })
export class McpModule {}
