import type { AuthUser, RagChatResponse } from '@policymanager/shared';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RagChatController } from './rag-chat.controller';
import { ChatService } from './chat.service';
import { RagMetricsService } from '../metrics/rag-metrics.service';
import { EmbeddingService } from '../embedding.service';
import { ChatRequestDto } from './dto/chat.dto';

describe('RagChatController', () => {
  const user = { id: 'user-1', permissions: [] } as unknown as AuthUser;
  const ctx = { ipAddress: '10.0.0.1', userAgent: 'jest' };

  /** Minimal ChatService mock exposing the three methods the controller calls. */
  const makeService = () =>
    ({
      chat: jest.fn(),
      listConversations: jest.fn(),
      getConversation: jest.fn(),
    }) as unknown as jest.Mocked<Pick<ChatService, 'chat' | 'listConversations' | 'getConversation'>>;

  /** Minimal RagMetricsService mock exposing getStatus. */
  const makeMetrics = () =>
    ({ getStatus: jest.fn() }) as unknown as jest.Mocked<Pick<RagMetricsService, 'getStatus'>>;

  /** Minimal EmbeddingService mock exposing embedPending. */
  const makeEmbedding = () =>
    ({ embedPending: jest.fn() }) as unknown as jest.Mocked<Pick<EmbeddingService, 'embedPending'>>;

  const build = (service = makeService(), metrics = makeMetrics(), embedding = makeEmbedding()) =>
    new RagChatController(
      service as unknown as ChatService,
      metrics as unknown as RagMetricsService,
      embedding as unknown as EmbeddingService,
    );

  describe('POST chat', () => {
    it('forwards message + conversationId, user, and request context to chatService.chat and returns its result', async () => {
      const service = makeService();
      const response: RagChatResponse = {
        conversationId: 'c-1',
        answer: 'grounded [1]',
        citations: [],
        grounded: true,
      };
      service.chat.mockResolvedValue(response);
      const controller = build(service);

      const dto: ChatRequestDto = { message: 'what is our PTO policy?', conversationId: 'c-1' };
      const result = await controller.chat(dto, user, ctx);

      expect(service.chat).toHaveBeenCalledTimes(1);
      expect(service.chat).toHaveBeenCalledWith(
        { message: 'what is our PTO policy?', conversationId: 'c-1' },
        user,
        ctx,
      );
      expect(result).toBe(response);
    });
  });

  describe('GET conversations', () => {
    it('delegates to chatService.listConversations with the user + pagination', async () => {
      const service = makeService();
      const page = { items: [{ id: 'c-1', title: 't', createdAt: 'x', updatedAt: 'y' }], hasMore: true };
      service.listConversations.mockResolvedValue(page as never);
      const controller = build(service);

      // Query params arrive as strings; the controller parses them to ints.
      const result = await controller.listConversations(user, '5', '0');

      expect(service.listConversations).toHaveBeenCalledWith(user, { limit: 5, offset: 0 });
      expect(result).toBe(page);
    });

    it('parses omitted/blank pagination to undefined (no 400 on absent params)', async () => {
      const service = makeService();
      service.listConversations.mockResolvedValue({ items: [], hasMore: false } as never);
      const controller = build(service);

      await controller.listConversations(user, undefined, '');

      expect(service.listConversations).toHaveBeenCalledWith(user, {
        limit: undefined,
        offset: undefined,
      });
    });
  });

  describe('GET conversations/:id', () => {
    it('delegates to chatService.getConversation with id, user + message pagination', async () => {
      const service = makeService();
      const convo = { id: 'c-1', title: 't', messages: [], hasMoreOlder: true, oldestSequence: 11 };
      service.getConversation.mockResolvedValue(convo as never);
      const controller = build(service);

      const result = await controller.getConversation('c-1', user, '10', '11');

      expect(service.getConversation).toHaveBeenCalledWith('c-1', user, {
        messageLimit: 10,
        before: 11,
      });
      expect(result).toBe(convo);
    });

    it('loads the latest page when no cursor is given (absent params → undefined)', async () => {
      const service = makeService();
      service.getConversation.mockResolvedValue({ messages: [], hasMoreOlder: false } as never);
      const controller = build(service);

      // messageLimit present, before ABSENT — the exact shape the frontend sends,
      // and the exact case that used to 400 with ParseIntPipe({optional}).
      await controller.getConversation('c-1', user, '10', undefined);

      expect(service.getConversation).toHaveBeenCalledWith('c-1', user, {
        messageLimit: 10,
        before: undefined,
      });
    });
  });

  describe('GET status', () => {
    it('delegates to metrics.getStatus and returns its result', async () => {
      const metrics = makeMetrics();
      const snapshot = {
        enabled: true,
        configured: true,
        embeddingModel: 'text-embedding-3-small',
        embeddingDimensions: 1536,
        chatModel: 'gpt-4o-mini',
        embeddingBacklog: { pending: 0, processing: 0, done: 0, failed: 0, skipped: 0 },
      };
      metrics.getStatus.mockResolvedValue(snapshot);
      const controller = build(makeService(), metrics);

      const result = await controller.status(user);

      expect(metrics.getStatus).toHaveBeenCalledTimes(1);
      expect(result).toBe(snapshot);
    });
  });

  describe('authentication', () => {
    it('is protected by JwtAuthGuard at the controller level', () => {
      // Auth (401) is enforced by the guard at the integration layer; here we
      // assert the guard is actually wired so the routes can never be public.
      const guards = Reflect.getMetadata(GUARDS_METADATA, RagChatController) ?? [];
      expect(guards).toContain(JwtAuthGuard);
    });
  });
});
