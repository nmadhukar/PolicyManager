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
/** Default conversations returned per page (matches the UI's "5 at a time"). */
const DEFAULT_CONVERSATION_PAGE_SIZE = 5;
/** Upper bound so a client can't request an unbounded conversation page. */
const MAX_CONVERSATION_PAGE_SIZE = 50;
/** Default message ROWS per page (a turn = user+assistant, so 10 rows ≈ 5 turns). */
const DEFAULT_MESSAGE_PAGE_SIZE = 10;
/** Upper bound on message rows per page. */
const MAX_MESSAGE_PAGE_SIZE = 100;

/** One row in the paginated conversation list (dates serialized to ISO strings). */
export interface ConversationSummaryDto {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

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
    let citations = this.filterReferencedCitations(answer, context.citations);

    // The model cited NOTHING. Two very different cases hide behind this, and they
    // must NOT be treated the same (the old bug: a real, correct answer that merely
    // forgot its [n] markers was discarded and replaced with "I couldn't find…",
    // which is why the SAME question failed once then worked on retry):
    //
    //  (a) The model actually declined to answer (a greeting, small talk, or an
    //      honest "I don't have a source for that"). → show the warm conversational
    //      reply, no sources.
    //  (b) The model DID answer substantively from the context but omitted the
    //      bracket markers (LLMs do this intermittently). → keep the answer and
    //      attach the sources we gave it, rather than throwing a good answer away.
    if (citations.length === 0) {
      if (this.looksLikeNonAnswer(answer)) {
        let reply: string;
        try {
          reply = (await this.llm.complete(buildConversationalMessages(message, history))).trim();
        } catch {
          reply = NO_SOURCE_ANSWER;
        }
        this.logger.log('chat answered: grounded=false (model declined to answer)');
        return this.persistAndRespond(user, input.conversationId, message, reply, [], false, ctx);
      }
      // Substantive answer with no markers → salvage it: attach the sources that
      // were in the grounding context (already ACL-scoped) so the user still gets
      // the answer AND its provenance. Deterministic, no extra LLM call.
      citations = context.citations;
      this.logger.log(
        `chat answered: grounded=true (recovered ${citations.length} uncited sources)`,
      );
      return this.persistAndRespond(user, input.conversationId, message, answer, citations, true, ctx);
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
   * Retain only citations whose [n] marker actually appears in the answer. This is
   * what maps an answer's inline markers back to the sources it used.
   */
  private filterReferencedCitations(answer: string, citations: RagCitation[]): RagCitation[] {
    return citations.filter((c) => answer.includes(`[${c.index}]`));
  }

  /**
   * Heuristic: does an UNCITED grounded reply read as the model DECLINING to answer
   * (a refusal / greeting / "no source") rather than a real answer that merely forgot
   * its [n] markers? Used to decide whether to fall back to the conversational reply
   * or salvage the answer + attach sources. Deliberately conservative — it only
   * matches clear refusal phrasing and very short replies, so a genuine answer is
   * never mistaken for a non-answer.
   */
  private looksLikeNonAnswer(answer: string): boolean {
    const text = answer.trim().toLowerCase();
    // Very short replies are greetings/acknowledgements, not policy answers.
    if (text.length < 40) return true;
    // Explicit "I couldn't find / don't have a source" style refusals.
    const refusalPatterns = [
      /\b(i (do not|don't|couldn't|could not|cannot|can't))\b.*\b(find|have|see|locate)\b/,
      /\bno (policy|document|source|information)\b.*\b(cover|found|available|match)/,
      /\bi('?m| am) (unable|not able)\b/,
      /\bcontact (the|your) (policy owner|administrator|hr)\b/,
    ];
    return refusalPatterns.some((re) => re.test(text));
  }

  /**
   * List the caller's conversations, most-recent-first, PAGINATED. Fetches
   * `limit + 1` rows to cheaply detect whether more pages exist (`hasMore`) without
   * a second count query. `limit`/`offset` are clamped to sane bounds. Default page 5.
   */
  async listConversations(
    user: AuthUser,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ items: ConversationSummaryDto[]; hasMore: boolean }> {
    const limit = Math.min(
      Math.max(1, Math.floor(opts.limit ?? DEFAULT_CONVERSATION_PAGE_SIZE)),
      MAX_CONVERSATION_PAGE_SIZE,
    );
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const rows = await this.prisma.ragConversation.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
      skip: offset,
      take: limit + 1, // one extra row → tells us if another page exists
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return { items, hasMore };
  }

  /**
   * Load a conversation with a PAGE of its messages, newest-anchored. The chat UI
   * shows the most recent turns first and lazily loads OLDER ones as the user
   * scrolls up (reverse infinite scroll), so:
   *  - with no `before` cursor we return the NEWEST `messageLimit` rows;
   *  - with `before` (a sequence) we return the `messageLimit` rows just older than it.
   * Either way the returned `messages` are in ASCENDING (oldest→newest) order for
   * display. `hasMoreOlder` tells the client whether an older page exists, and
   * `oldestSequence` is the cursor to request it. A page is `messageLimit` message
   * ROWS (a turn is a user+assistant pair, so 10 rows ≈ 5 turns).
   */
  async getConversation(
    id: string,
    user: AuthUser,
    opts: { messageLimit?: number; before?: number } = {},
  ) {
    const convo = await this.prisma.ragConversation.findUnique({
      where: { id },
      select: { id: true, userId: true, title: true, createdAt: true, updatedAt: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    if (convo.userId !== user.id) throw new ForbiddenException('Not your conversation');

    const limit = Math.min(
      Math.max(2, Math.floor(opts.messageLimit ?? DEFAULT_MESSAGE_PAGE_SIZE)),
      MAX_MESSAGE_PAGE_SIZE,
    );
    const before = typeof opts.before === 'number' ? opts.before : undefined;

    // Fetch NEWEST-first (descending), bounded by the cursor, taking limit+1 to detect
    // whether an even-older page exists. Then reverse to ascending for display.
    const rows = await this.prisma.ragMessage.findMany({
      where: {
        conversationId: id,
        ...(before !== undefined ? { sequence: { lt: before } } : {}),
      },
      orderBy: { sequence: 'desc' },
      take: limit + 1,
      select: { sequence: true, role: true, content: true, citations: true, grounded: true, createdAt: true },
    });
    const hasMoreOlder = rows.length > limit;
    const page = rows.slice(0, limit).reverse(); // oldest→newest for rendering
    const oldestSequence = page.length > 0 ? page[0].sequence : null;

    return {
      id: convo.id,
      title: convo.title,
      createdAt: convo.createdAt.toISOString(),
      updatedAt: convo.updatedAt.toISOString(),
      hasMoreOlder,
      oldestSequence,
      messages: page.map((m) => ({
        sequence: m.sequence,
        role: m.role,
        content: m.content,
        grounded: m.grounded,
        citations: (m.citations as unknown as RagCitation[] | null) ?? [],
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }
}
