import { Fragment, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RagCitation, RagChatResponse } from '@policymanager/shared';
import {
  getConversation,
  listConversations,
  sendChat,
  type ConversationMessage,
} from '../api/ragChat';
import { apiErrorMessage } from '../lib/apiError';
import { AppShell } from '../ui/AppShell';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { useToast } from '../ui/Toast';

/** A message as held in the page's local thread state (assistant turns can be
 * pending — the "thinking…" placeholder — while the request is in flight). */
interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  grounded: boolean;
  citations: RagCitation[];
  createdAt?: string;
  pending?: boolean;
}

function toThreadMessage(message: ConversationMessage): ThreadMessage {
  return {
    role: message.role,
    content: message.content,
    grounded: message.grounded,
    citations: message.citations ?? [],
    createdAt: message.createdAt,
  };
}

function formatMessageTime(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ChatPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');

  const conversationsQuery = useQuery({
    queryKey: ['rag-conversations'],
    queryFn: listConversations,
  });

  const sendMutation = useMutation({
    mutationFn: (message: string) => sendChat(message, conversationId ?? undefined),
    onSuccess: (response: RagChatResponse) => {
      setConversationId(response.conversationId);
      // Replace the pending "thinking…" placeholder with the real answer.
      setThread((prev) => {
        const next = [...prev];
        const lastIndex = next.length - 1;
        if (lastIndex >= 0 && next[lastIndex].pending) {
          next[lastIndex] = {
            role: 'assistant',
            content: response.answer,
            grounded: response.grounded,
            citations: response.citations,
            createdAt: new Date().toISOString(),
          };
        }
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['rag-conversations'] });
    },
    onError: (err) => {
      // Drop the pending placeholder so the thread doesn't hang on "thinking…".
      setThread((prev) => prev.filter((m) => !m.pending));
      toast.error(apiErrorMessage(err, 'Could not get an answer. Please try again.'));
    },
  });

  const send = () => {
    const message = draft.trim();
    if (!message || sendMutation.isPending) return;
    setThread((prev) => [
      ...prev,
      { role: 'user', content: message, grounded: true, citations: [], createdAt: new Date().toISOString() },
      { role: 'assistant', content: '', grounded: true, citations: [], pending: true },
    ]);
    setDraft('');
    sendMutation.mutate(message);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const startNewChat = () => {
    setConversationId(null);
    setThread([]);
    setDraft('');
  };

  const openConversation = async (id: string) => {
    if (sendMutation.isPending) return;
    setConversationId(id);
    try {
      const detail = await getConversation(id);
      setThread(detail.messages.map(toThreadMessage));
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load that conversation.'));
    }
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold text-ink">Policy chatbot</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Ask a question about your clinic&apos;s policies and get answers grounded in your
          documents, with links to the sources.
        </p>

        <div className="mt-5 grid gap-4 lg:grid-cols-[16rem_1fr]">
          <ConversationSidebar
            query={conversationsQuery}
            activeId={conversationId}
            onSelect={openConversation}
            onNewChat={startNewChat}
          />
          <ChatThread
            thread={thread}
            draft={draft}
            onDraftChange={setDraft}
            onSend={send}
            onKeyDown={onKeyDown}
            pending={sendMutation.isPending}
          />
        </div>
      </div>
    </AppShell>
  );
}

function ConversationSidebar({
  query,
  activeId,
  onSelect,
  onNewChat,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof listConversations>>>>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  const conversations = query.data ?? [];
  return (
    <aside
      className="card flex h-[calc(100vh-14rem)] min-h-[28rem] flex-col gap-3 p-3"
      aria-label="Conversations"
    >
      <button className="btn-primary w-full" onClick={onNewChat}>
        New chat
      </button>
      <div className="flex-1 overflow-y-auto">
        {query.isLoading ? (
          <LoadingState label="Loading conversations…" />
        ) : query.isError ? (
          <ErrorState
            description="We couldn't load your conversations."
            onRetry={() => void query.refetch()}
          />
        ) : conversations.length === 0 ? (
          <p className="px-1 py-2 text-sm text-ink-muted">
            No conversations yet. Ask your first question to get started.
          </p>
        ) : (
          <ul className="space-y-1">
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id}>
                  <button
                    className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm font-medium ${
                      active ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-slate-100'
                    }`}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(c.id)}
                    title={c.title ?? undefined}
                  >
                    {c.title || 'Untitled conversation'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ChatThread({
  thread,
  draft,
  onDraftChange,
  onSend,
  onKeyDown,
  pending,
}: {
  thread: ThreadMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  pending: boolean;
}) {
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thread]);

  return (
    <div className="card flex h-[calc(100vh-14rem)] min-h-[28rem] flex-col p-0">
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="flex-1 space-y-4 overflow-y-auto p-4"
      >
        {thread.length === 0 ? (
          <EmptyState
            title="Ask your first question"
            description="For example: “What is our seclusion and restraint policy?”"
          />
        ) : (
          thread.map((message, index) =>
            message.role === 'user' ? (
              <UserBubble key={index} content={message.content} createdAt={message.createdAt} />
            ) : message.pending ? (
              <PendingBubble key={index} />
            ) : (
              <AssistantBubble key={index} message={message} />
            ),
          )
        )}
      </div>

      <form
        className="flex items-end gap-2 border-t border-slate-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <textarea
          className="input min-h-[2.75rem] resize-none"
          rows={2}
          aria-label="Ask a question"
          placeholder="Ask a question…  (Enter to send, Shift+Enter for a new line)"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="btn-primary shrink-0"
          disabled={pending || draft.trim().length === 0}
          aria-label="Send message"
        >
          {pending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function UserBubble({ content, createdAt }: { content: string; createdAt?: string }) {
  const time = formatMessageTime(createdAt);
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-brand-600 px-4 py-2 text-sm text-white">
        {content}
      </div>
      {time && <span className="mt-1 text-xs text-ink-muted">{time}</span>}
    </div>
  );
}

function PendingBubble() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl bg-slate-100 px-4 py-2 text-sm text-ink-muted">
        Thinking…
      </div>
    </div>
  );
}

function AssistantBubble({ message }: { message: ThreadMessage }) {
  const citationsByIndex = useMemo(() => {
    const map = new Map<number, RagCitation>();
    for (const citation of message.citations) map.set(citation.index, citation);
    return map;
  }, [message.citations]);

  const hasCitations = message.grounded && message.citations.length > 0;
  const time = formatMessageTime(message.createdAt);

  return (
    <div className="flex flex-col items-start">
      <div className="max-w-[80%] space-y-3 rounded-2xl bg-slate-100 px-4 py-3 text-sm text-ink">
        <p className="whitespace-pre-wrap">
          <AnswerText text={message.content} citationsByIndex={citationsByIndex} />
        </p>

        {hasCitations && (
          <div className="space-y-2 border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Sources</p>
            <ul className="space-y-2">
              {message.citations.map((citation) => (
                <li key={citation.index} className="text-xs">
                  <Link
                    to={`/library/${citation.documentId}`}
                    className="font-medium text-brand-600 hover:underline"
                  >
                    [{citation.index}] {citation.documentTitle}
                    {citation.documentNumber ? ` (${citation.documentNumber})` : ''}
                  </Link>
                  {citation.snippet && (
                    <span className="mt-0.5 block text-ink-muted">{citation.snippet}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {time && <span className="mt-1 text-xs text-ink-muted">{time}</span>}
    </div>
  );
}

/**
 * Renders the answer text, turning inline `[n]` markers into links to the
 * matching citation's document. Markers without a matching citation are left as
 * plain text. (No markdown library exists in the app — we parse manually.)
 */
function AnswerText({
  text,
  citationsByIndex,
}: {
  text: string;
  citationsByIndex: Map<number, RagCitation>;
}) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = /^\[(\d+)\]$/.exec(part);
        if (match) {
          const index = Number(match[1]);
          const citation = citationsByIndex.get(index);
          if (citation) {
            return (
              <Link
                key={i}
                to={`/library/${citation.documentId}`}
                className="font-medium text-brand-600 hover:underline"
              >
                [{index}]
              </Link>
            );
          }
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
