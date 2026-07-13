import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './auth/AuthContext';

function renderApp(initialPath = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('App routing', () => {
  beforeEach(() => localStorage.clear());

  it('redirects an unauthenticated visitor from a protected route to the login page', async () => {
    renderApp('/');
    await waitFor(() =>
      expect(screen.getByText('Sign in to PolicyManager')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('redirects the admin users route to login when unauthenticated', async () => {
    renderApp('/admin/users');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument(),
    );
  });
});
