import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser, RagCitation, RagChatResponse } from '@policymanager/shared';
import { AUDIT_ACTIONS } from '@policymanager/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { RequestContext } from '../../audit/request-context';
import { RagConfigService } from '../rag-config.service';
import { AgentOrchestrator } from '../agent/agent-orchestrator.service';
import { CHAT_LLM_PROVIDER, type ChatLlmProvider, type ChatMessage } from './chat-llm-provider';
import { buildMessages, buildConversationalMessages, NO_SOURCE_ANSWER } from './prompts';

export interface ChatInput {
  message: string;
  conversationId?: string;
}

const MAX_TITLE_CHARS = 80;

/**
 * The grounded-answer service (RAG Phase 4). Ties the Phase 3 orchestrator to an
 * LLM: gathers ACL-scoped context, asks the model to answer strictly from it with
 * citations, persists the turn, and audits. Best-effort and gated — when the
 * provider is unconfigured OR no sources are found, it returns an honest
 * "no source" answer WITHOUT any LLM egress.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ragConfig: RagConfigService,
    private readonly orchestrator: AgentOrchestrator,
    @Inject(CHAT_LLM_PROVIDER) private readonly llm: ChatLlmProvider,
  ) {}

  async chat(input: ChatInput, user: AuthUser, ctx: RequestContext = {}): Promise<RagChatResponse> {
    const message = (input.message ?? '').trim();
    if (message.length === 0) {
      return this.persistAndRespond(user, input.conversationId, message, NO_SOURCE_ANSWER, [], false, ctx);
    }

    // Gather ACL-scoped grounding context (only docs this user may see).
    const { context } = await this.orchestrator.answerableContext(message, { user });
    const history = await this.loadHistory(input.conversationId, user.id);

    // LLM unconfigured → static fallback, ZERO egress.
    if (!this.llm.isConfigured()) {
      return this.persistAndRespond(
        user,
        input.conversationId,
        message,
        NO_SOURCE_ANSWER,
        [],
        false,
        ctx,
      );
    }

    // No relevant sources: this is a greeting, small talk, or a topic no document
    // covers. Give a warm, balanced conversational reply that acknowledges the
    // user and politely invites a policy question — NOT a cold "no source" wall,
    // and NEVER any citations. The conversational prompt still forbids inventing
    // policy facts, so it can't hallucinate a policy it has no source for.
    if (context.empty) {
      let reply: string;
      try {
        reply = (await this.llm.complete(buildConversationalMessages(message, history))).trim();
      } catch (err) {
        this.logger.warn(`Conversational completion failed: ${(err as Error).message}`);
        reply = NO_SOURCE_ANSWER;
      }
      return this.persistAndRespond(user, input.conversationId, message, reply, [], false, ctx);
    }

    const messages = buildMessages(message, context, history);

    let answer: string;
    try {
      answer = (await this.llm.complete(messages)).trim();
    } catch (err) {
      this.logger.warn(`Chat completion failed: ${(err as Error).message}`);
      // Fail safe: never surface a raw provider error; give the fallback.
      return this.persistAndRespond(
        user,
        input.conversationId,
        message,
        NO_SOURCE_ANSWER,
        [],
        false,
        ctx,
      );
    }

    // Keep only citations the answer actually references ([n] markers present).
    const citations = this.filterReferencedCitations(answer, context.citations);

    // The grounded model was given (weak) context but cited NOTHING — meaning the
    // sources didn't actually answer the question (a greeting, small talk, or a
    // near-miss). Rather than show the cold grounded refusal, give the warm
    // conversational reply. This is the robust signal that a distance threshold
    // alone can't provide (a greeting can out-score a loosely-worded real query).
    if (citations.length === 0) {
      let reply: string;
      try {
        reply = (await this.llm.complete(buildConversationalMessages(message, history))).trim();
      } catch {
        reply = NO_SOURCE_ANSWER;
      }
      this.logger.log('chat answered: grounded=false (no citations in grounded answer)');
      return this.persistAndRespond(user, input.conversationId, message, reply, [], false, ctx);
    }

    // PII-safe observability: log the outcome shape only — never the question,
    // the answer, or any chunk/source text.
    this.logger.log(
      `chat answered: grounded=true citations=${citations.length} sources=${context.citations.length}`,
    );
    return this.persistAndRespond(user, input.conversationId, message, answer, citations, true, ctx);
  }

  /** Prior turns for a conversation, oldest→newest, bounded by config. */
  private async loadHistory(conversationId: string | undefined, userId: string): Promise<ChatMessage[]> {
    if (!conversationId) return [];
    const convo = await this.prisma.ragConversation.findUnique({
      where: { id: conversationId },
      select: { userId: true },
    });
    // Silently ignore history from a conversation the user doesn't own (the
    // create path below will start a fresh one). Never leak another user's turns.
    if (!convo || convo.userId !== userId) return [];

    const turns = this.ragConfig.chatHistoryTurns;
    const rows = await this.prisma.ragMessage.findMany({
      where: { conversationId },
      orderBy: { sequence: 'desc' },
      take: turns * 2, // user+assistant per turn
      select: { role: true, content: true },
    });
    return rows
      .reverse()
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  /** Persist the user + assistant messages and shape the response. */
  private async persistAndRespond(
    user: AuthUser,
    conversationId: string | undefined,
    userMessage: string,
    answer: string,
    citations: RagCitation[],
    grounded: boolean,
    ctx: RequestContext,
  ): Promise<RagChatResponse> {
    const convo = await this.resolveConversation(conversationId, user, userMessage);

    await this.prisma.ragMessage.createMany({
      data: [
        { conversationId: convo.id, role: 'user', content: userMessage, grounded: false },
        {
          conversationId: convo.id,
          role: 'assistant',
          content: answer,
          grounded,
          citations: citations.length > 0 ? (citations as unknown as object) : undefined,
        },
      ],
    });
    await this.prisma.ragConversation.update({
      where: { id: convo.id },
      data: { updatedAt: new Date() },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.RAG_CHAT,
      actorUserId: user.id,
      targetType: 'rag_conversation',
      ...ctx,
      // No message text in audit metadata (could contain sensitive content).
      metadata: { conversationId: convo.id, grounded, citations: citations.length },
    });

    return { conversationId: convo.id, answer, citations, grounded };
  }

  /**
   * Load the caller's existing conversation or create a new one. A conversationId
   * that doesn't exist or belongs to another user starts a fresh conversation
   * rather than erroring — the chat never leaks or writes into someone else's thread.
   */
  private async resolveConversation(
    conversationId: string | undefined,
    user: AuthUser,
    firstMessage: string,
  ): Promise<{ id: string }> {
    if (conversationId) {
      const existing = await this.prisma.ragConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, userId: true },
      });
      if (existing && existing.userId === user.id) return { id: existing.id };
    }
    const created = await this.prisma.ragConversation.create({
      data: { userId: user.id, title: firstMessage.slice(0, MAX_TITLE_CHARS) || null },
      select: { id: true },
    });
    return created;
  }

  /**
   * Retain only citations whose [n] marker actually appears in the answer. If the
   * model cited nothing, return NONE — an answer that references no source is not
   * grounded in one, so we must not attach (misleading) sources to it. This is
   * what prevents an "I don't have a source" reply from showing a Sources list.
   */
  private filterReferencedCitations(answer: string, citations: RagCitation[]): RagCitation[] {
    return citations.filter((c) => answer.includes(`[${c.index}]`));
  }

  /** List the caller's conversations (most recent first). */
  async listConversations(user: AuthUser) {
    const rows = await this.prisma.ragConversation.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** Load one conversation's messages — only if the caller owns it (else 403/404). */
  async getConversation(id: string, user: AuthUser) {
    const convo = await this.prisma.ragConversation.findUnique({
      where: { id },
      select: { id: true, userId: true, title: true, createdAt: true, updatedAt: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    if (convo.userId !== user.id) throw new ForbiddenException('Not your conversation');

    const messages = await this.prisma.ragMessage.findMany({
      where: { conversationId: id },
      orderBy: { sequence: 'asc' },
      select: { role: true, content: true, citations: true, grounded: true, createdAt: true },
    });
    return {
      id: convo.id,
      title: convo.title,
      createdAt: convo.createdAt.toISOString(),
      updatedAt: convo.updatedAt.toISOString(),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        grounded: m.grounded,
        citations: (m.citations as unknown as RagCitation[] | null) ?? [],
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }
}
