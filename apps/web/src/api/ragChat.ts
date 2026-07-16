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
  role: 'user' | 'assistant';
  content: string;
  grounded: boolean;
  citations: RagCitation[];
  createdAt: string;
}

/** Full conversation with its messages (GET /rag/conversations/:id). */
export interface ConversationDetail {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

/** Sends a chat message, optionally continuing an existing conversation. */
export async function sendChat(message: string, conversationId?: string): Promise<RagChatResponse> {
  const { data } = await http.post<RagChatResponse>('/rag/chat', { message, conversationId });
  return data;
}

/** Lists the current user's conversations, most recent activity first. */
export async function listConversations(): Promise<ConversationSummary[]> {
  const { data } = await http.get<ConversationSummary[]>('/rag/conversations');
  return data;
}

/** Fetches a single conversation with its full message history. */
export async function getConversation(id: string): Promise<ConversationDetail> {
  const { data } = await http.get<ConversationDetail>(`/rag/conversations/${id}`);
  return data;
}
