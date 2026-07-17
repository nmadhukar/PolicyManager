import type { RagChatResponse, RagCitation } from '@policymanager/shared';
import { http } from './http';

/** A conversation as returned in the list (GET /rag/conversations). */
export interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single stored message inside a conversation detail. */
export interface ConversationMessage {
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  grounded: boolean;
  citations: RagCitation[];
  createdAt: string;
}

/** Full conversation with a page of its messages (GET /rag/conversations/:id). */
export interface ConversationDetail {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
  hasMoreOlder: boolean;
  oldestSequence: number | null;
}

/** A page of conversations (GET /rag/conversations?limit&offset). */
export interface ConversationPage {
  items: ConversationSummary[];
  hasMore: boolean;
}

/** Sends a chat message, optionally continuing an existing conversation. */
export async function sendChat(message: string, conversationId?: string): Promise<RagChatResponse> {
  const { data } = await http.post<RagChatResponse>('/rag/chat', { message, conversationId });
  return data;
}

/**
 * Lists the current user's conversations, most recent activity first. The API is
 * paginated ({ items, hasMore }); this page fetches a generous first page (no
 * infinite scroll here — the ESS Portal assistant drives that).
 */
export async function listConversations(
  params: { limit?: number; offset?: number } = {},
): Promise<ConversationPage> {
  const { data } = await http.get<ConversationPage>('/rag/conversations', { params });
  return data;
}

/**
 * Fetches a page of a conversation's messages (newest-first pagination). Omit
 * `before` for the latest page; pass the previous `oldestSequence` as `before` to
 * load older messages. This page requests a large messageLimit to load the whole
 * history at once (no reverse-scroll UI here).
 */
export async function getConversation(
  id: string,
  params: { messageLimit?: number; before?: number } = {},
): Promise<ConversationDetail> {
  const { data } = await http.get<ConversationDetail>(`/rag/conversations/${id}`, {
    params: { messageLimit: params.messageLimit ?? 500, ...params },
  });
  return data;
}
