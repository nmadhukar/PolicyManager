import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthUser, type RagChatResponse } from '@policymanager/shared';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator';
import { ReqContext, type RequestContext } from '../../audit/request-context';
import { EmbeddingService } from '../embedding.service';
import { RagMetricsService } from '../metrics/rag-metrics.service';
import { ChatService } from './chat.service';
import { ChatRequestDto } from './dto/chat.dto';

/**
 * Dedicated throttle for the LLM-backed chat route (Phase 6). Much tighter than
 * the generous global default because each call can trigger an OpenAI request:
 * 20 requests / 60s per client. Tunable via RAG_CHAT_RATE_LIMIT / RAG_CHAT_RATE_TTL_MS
 * (those env vars document the intended limit; the decorator values mirror the
 * defaults). Exceeding it returns HTTP 429.
 */
const CHAT_RATE_LIMIT = Number(process.env.RAG_CHAT_RATE_LIMIT ?? 20);
const CHAT_RATE_TTL_MS = Number(process.env.RAG_CHAT_RATE_TTL_MS ?? 60_000);

/**
 * The grounded-chat API (RAG Phase 4). Every route requires an authenticated
 * user (JwtAuthGuard); authorization beyond authentication is enforced inside
 * ChatService — retrieval is ACL-scoped to what the caller may see, and
 * conversation reads/writes are owner-checked, so no per-permission guard is
 * needed here. Answers are grounded strictly in retrieved sources with citations.
 */
@ApiTags('RAG chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('rag')
export class RagChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly metrics: RagMetricsService,
    private readonly embedding: EmbeddingService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'RAG feature status + embedding backlog (authenticated).' })
  status(@CurrentUser() _user: AuthUser) {
    return this.metrics.getStatus();
  }

  @Post('reindex')
  @RequirePermission(PERMISSIONS.STORAGE_MANAGE)
  @ApiOperation({
    summary: 'Embed all published, extracted-but-unembedded document versions (operator backfill).',
  })
  reindex(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.embedding.embedPending(user, ctx);
  }

  @Post('chat')
  @Throttle({ default: { limit: CHAT_RATE_LIMIT, ttl: CHAT_RATE_TTL_MS } })
  @ApiOperation({ summary: 'Ask a grounded question; returns an answer with source citations.' })
  chat(
    @Body() dto: ChatRequestDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ): Promise<RagChatResponse> {
    return this.chatService.chat({ message: dto.message, conversationId: dto.conversationId }, user, ctx);
  }

  @Get('conversations')
  @ApiOperation({ summary: "List the caller's chat conversations (most recent first)." })
  listConversations(@CurrentUser() user: AuthUser) {
    return this.chatService.listConversations(user);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: "Get one of the caller's conversations with its full message history." })
  getConversation(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.chatService.getConversation(id, user);
  }
}
