import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './AppShell';

const mockLogout = vi.fn();
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'a@b.com',
      name: 'Admin User',
      roles: ['Admin'],
      permissions: [],
      mustChangePassword: false,
    },
    status: 'authenticated',
    login: vi.fn(),
    logout: mockLogout,
    changePassword: vi.fn(),
    hasPermission: () => true,
  }),
}));

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AppShell>
          <div>page content</div>
        </AppShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell mobile navigation (FM1)', () => {
  it('opens the nav drawer from the hamburger and reflects aria-expanded', () => {
    renderShell();
    const button = screen.getByRole('button', { name: 'Open navigation menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'mobile-nav');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();
  });

  it('closes the drawer on Escape', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();
  });

  it('closes the drawer when a nav link is followed', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });

    fireEvent.click(within(drawer).getByRole('link', { name: 'Dashboard' }));
    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();
  });
});

describe('AppShell user menu', () => {
  beforeEach(() => mockLogout.mockReset());

  it('opens a dropdown with Change password + Sign out from the avatar button', () => {
    renderShell();
    const trigger = screen.getByRole('button', { expanded: false, name: /Admin User/i });
    expect(screen.queryByRole('menu', { name: 'User menu' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'User menu' });
    expect(within(menu).getByRole('menuitem', { name: /Change password/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Sign out/i })).toBeInTheDocument();
  });

  it('signs out when Sign out is chosen', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { expanded: false, name: /Admin User/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sign out/i }));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('closes the menu on Escape', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { expanded: false, name: /Admin User/i }));
    expect(screen.getByRole('menu', { name: 'User menu' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'User menu' })).not.toBeInTheDocument();
  });
});
