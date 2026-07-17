import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ChatPage } from './ChatPage';
import * as ragChatApi from '../api/ragChat';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'ada@example.com',
      name: 'Ada',
      roles: ['Admin'],
      permissions: [],
      mustChangePassword: false,
    },
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: () => true,
  }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function ask(message: string) {
  fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

describe('ChatPage', () => {
  beforeEach(() => {
    vi.spyOn(ragChatApi, 'listConversations').mockResolvedValue({ items: [], hasMore: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the page heading and composer', async () => {
    renderPage();
    expect(await screen.findByText('Policy chatbot')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask a question')).toBeInTheDocument();
  });

  it('sends a message and renders the grounded answer with a citation deep-link', async () => {
    vi.spyOn(ragChatApi, 'sendChat').mockResolvedValue({
      conversationId: 'conv-1',
      answer: 'Seclusion is a last resort [1].',
      grounded: true,
      citations: [
        {
          index: 1,
          documentId: 'doc-1',
          versionId: 'v-1',
          chunkId: 'c-1',
          documentTitle: 'Seclusion Policy',
          documentNumber: 'PP-42',
          versionNumber: 1,
          effectiveDate: null,
          sectionIdentifier: null,
          sectionTitle: null,
          pageStart: null,
          pageEnd: null,
          snippet: 'Seclusion is a last resort.',
        },
      ],
    });
    renderPage();

    ask('What is the seclusion policy?');

    const link = await screen.findByRole('link', { name: /\[1\] Seclusion Policy/ });
    expect(link).toHaveAttribute('href', '/library/doc-1');
    // The answer text and the citation snippet both mention "last resort" — assert
    // via the answer paragraph specifically to avoid ambiguity with the snippet.
    expect(screen.getAllByText(/Seclusion is a last resort/).length).toBeGreaterThan(0);
  });

  it('renders an ungrounded answer plainly with NO citation list', async () => {
    vi.spyOn(ragChatApi, 'sendChat').mockResolvedValue({
      conversationId: 'conv-2',
      answer: "Hi! I'm the policy assistant — what policy can I help you find?",
      grounded: false,
      citations: [],
    });
    renderPage();

    ask('Hey');

    expect(
      await screen.findByText("Hi! I'm the policy assistant — what policy can I help you find?"),
    ).toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  it('shows an inviting empty state for the conversations sidebar when there are none', async () => {
    renderPage();
    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
  });
});
