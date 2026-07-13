import { ReactNode, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { PERMISSIONS } from '@policymanager/shared';
import { useAuth } from '../auth/AuthContext';
import { useFocusTrap } from './useFocusTrap';

interface NavItem {
  label: string;
  to: string;
  icon: string;
  requires?: string;
}

const NAV: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: '▚' },
  { label: 'Library', to: '/library', icon: '▤', requires: PERMISSIONS.DOCUMENT_READ },
  { label: 'Import', to: '/library/import', icon: '⇪', requires: PERMISSIONS.DOCUMENT_WRITE },
  // Reviews is a personal dashboard: any signed-in user may be assigned as a reviewer.
  { label: 'Reviews', to: '/reviews', icon: '✔' },
  // Acknowledgments is personal too: any signed-in user may be assigned to read & sign.
  { label: 'Acknowledgments', to: '/acknowledgments', icon: '✍' },
  { label: 'Audit Log', to: '/admin/audit', icon: '▧', requires: PERMISSIONS.AUDIT_READ },
  { label: 'Users', to: '/admin/users', icon: '⚙', requires: PERMISSIONS.USER_MANAGE },
  { label: 'Storage', to: '/admin/storage', icon: '▦', requires: PERMISSIONS.STORAGE_MANAGE },
  { label: 'Email', to: '/admin/email', icon: '✉', requires: PERMISSIONS.SMTP_MANAGE },
  { label: 'API Clients', to: '/admin/api-clients', icon: '⚿', requires: PERMISSIONS.API_MANAGE },
];

function NavItems({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
              isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-slate-100'
            }`
          }
        >
          <span aria-hidden className="text-ink-muted">
            {item.icon}
          </span>
          {item.label}
        </NavLink>
      ))}
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout, hasPermission } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  const visibleNav = NAV.filter(
    (item) => !item.requires || hasPermission(item.requires as never),
  );

  const closeMobileNav = () => setMobileNavOpen(false);
  // Trap focus in the drawer while open; Escape closes it.
  useFocusTrap(mobileNavOpen, drawerRef, closeMobileNav);

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '?';

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            PM
          </span>
          <span className="font-semibold text-ink">PolicyManager</span>
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Primary">
          <NavItems items={visibleNav} />
        </nav>
        <div className="border-t border-slate-200 p-4 text-xs text-ink-muted">
          CARF / Joint Commission ready
        </div>
      </aside>

      {/* Mobile nav drawer (below md). Closes on nav, Escape, or backdrop. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={closeMobileNav}
            aria-hidden
          />
          <div
            ref={drawerRef}
            id="mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-64 max-w-[80%] flex-col border-r border-slate-200 bg-white focus:outline-none"
          >
            <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
                  PM
                </span>
                <span className="font-semibold text-ink">PolicyManager</span>
              </div>
              <button
                className="rounded-md p-1.5 text-ink-soft hover:bg-slate-100"
                onClick={closeMobileNav}
                aria-label="Close navigation menu"
              >
                ✕
              </button>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Primary">
              <NavItems items={visibleNav} onNavigate={closeMobileNav} />
            </nav>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              className="rounded-md p-2 text-ink-soft hover:bg-slate-100 md:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileNavOpen}
              aria-controls="mobile-nav"
            >
              <span aria-hidden className="text-lg leading-none">
                ☰
              </span>
            </button>
            <div className="truncate text-sm text-ink-muted">
              Behavioral Health Document Management
            </div>
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="grid h-8 w-8 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700"
                >
                  {initials}
                </span>
                <div className="hidden text-right sm:block">
                  <div className="text-sm font-medium text-ink">{user.name}</div>
                  <div className="text-xs text-ink-muted">{user.roles.join(', ') || 'No roles'}</div>
                </div>
              </div>
            )}
            <Link
              to="/change-password"
              className="hidden text-sm font-medium text-ink-soft hover:text-brand-600 sm:inline"
            >
              Change password
            </Link>
            <button className="btn-secondary" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
