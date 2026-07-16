import { Module, forwardRef } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { ChunkingService } from './chunking.service';
import { StructureDetectorService } from './structure-detector.service';
import { StructureAwareChunkingService } from './structure-aware-chunking.service';
import { EmbeddingService } from './embedding.service';
import { RetrieverService } from './retriever.service';
import { EmbeddingCache } from './embedding-cache.service';
import { RagConfigService } from './rag-config.service';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';
import { EMBEDDING_PROVIDER } from './embedding-provider';
import { TOOL_REGISTRY } from './agent/agent-tool';
import { SearchPolicyDocumentsTool } from './agent/search-policy-documents.tool';
import { ContextBuilder } from './agent/context-builder.service';
import { AgentOrchestrator } from './agent/agent-orchestrator.service';
import { CHAT_LLM_PROVIDER } from './chat/chat-llm-provider';
import { OpenAiChatProvider } from './chat/openai-chat.provider';
import { ChatService } from './chat/chat.service';
import { RagChatController } from './chat/rag-chat.controller';
import { RagMetricsService } from './metrics/rag-metrics.service';
import { AuthModule } from '../auth/auth.module';

/**
 * RAG (retrieval-augmented generation) module.
 *  - Phase 1: the semantic embedding index (ADR-0002) — chunker, OpenAI-backed
 *    provider (bound to the vendor-agnostic EMBEDDING_PROVIDER token), config,
 *    and the EmbeddingService worker.
 *  - Phase 2: the RetrieverService (hybrid vector+FTS retrieval).
 *
 * PrismaService, S3Service, and AuditService come from their @Global() modules.
 * DocumentsModule is imported (forwardRef — DocumentsModule also imports RagModule
 * for the extraction embedding hook) to reuse DocumentAccessService for the
 * retrieval ACL re-filter. EmbeddingService + RetrieverService are exported so the
 * documents/attestation modules and future chat module can consume them.
 */
@Module({
  imports: [forwardRef(() => DocumentsModule), AuthModule],
  controllers: [RagChatController],
  providers: [
    ChunkingService,
    // Structure-aware ingestion (Phase 2): the generic boundary detector and the
    // chunker that composes it with the token chunker. EmbeddingService depends on
    // StructureAwareChunkingService (which holds ChunkingService + the detector).
    StructureDetectorService,
    StructureAwareChunkingService,
    RagConfigService,
    OpenAiEmbeddingProvider,
    { provide: EMBEDDING_PROVIDER, useExisting: OpenAiEmbeddingProvider },
    EmbeddingService,
    EmbeddingCache,
    RetrieverService,
    // Agent layer (Phase 3): the tool, the registry (multi-provider so future
    // tools self-register), the context builder, and the thin orchestrator.
    // Registry is a factory so the token collects every tool; add a tool here by
    // injecting it and returning it alongside the others.
    SearchPolicyDocumentsTool,
    {
      provide: TOOL_REGISTRY,
      useFactory: (search: SearchPolicyDocumentsTool) => [search],
      inject: [SearchPolicyDocumentsTool],
    },
    ContextBuilder,
    AgentOrchestrator,
    // Chat / grounded answers (Phase 4): the LLM provider (bound to the vendor-
    // agnostic token), the chat service, wired to the controller above.
    OpenAiChatProvider,
    { provide: CHAT_LLM_PROVIDER, useExisting: OpenAiChatProvider },
    ChatService,
    // Status / metrics (Phase 6): read-only RAG status + embedding backlog for the
    // authenticated GET /rag/status route. Exposes no secrets (no API key).
    RagMetricsService,
  ],
  exports: [EmbeddingService, RetrieverService, AgentOrchestrator, ContextBuilder, ChatService],
})
export class RagModule {}
