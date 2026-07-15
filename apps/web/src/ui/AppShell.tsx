import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS } from '@policymanager/shared';
import { useAuth } from '../auth/AuthContext';
import { getUnreadNotificationCount } from '../api/notifications';
import { useFocusTrap } from './useFocusTrap';

/* Inline heroicons-style (24/outline) SVGs — PolicyManager ships no icon library
 * (nav uses text codes), so header icons are inlined to avoid a new dependency. */
function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
      />
    </svg>
  );
}
function UserCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
      />
    </svg>
  );
}
function KeyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"
      />
    </svg>
  );
}
function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
      />
    </svg>
  );
}

/* Sidebar nav icons (heroicons 24/outline, inlined — see the no-icon-library
 * note above). Each takes a className so NavItems can size + color them. */
type IconType = (props: { className?: string }) => JSX.Element;
function svgIcon(d: string): IconType {
  return function Icon({ className }: { className?: string }) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d={d} />
      </svg>
    );
  };
}
const HomeIcon = svgIcon('m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25');
const BookOpenIcon = svgIcon('M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25');
const ArrowUpTrayIcon = svgIcon('M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5');
const DocumentCheckIcon = svgIcon('M10.125 2.25h-4.5c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Zm-1.5 12 2.25 2.25 4.5-4.5m-6-4.5V3.75m6 6.75V3.75');
const CheckBadgeIcon = svgIcon('M9 12.75 11.25 15 15 9.75M21 12a2.25 2.25 0 0 1-1.32 2.05A2.25 2.25 0 0 1 18 16.5a2.25 2.25 0 0 1-2.05 1.32A2.25 2.25 0 0 1 12 21a2.25 2.25 0 0 1-3.95-1.18A2.25 2.25 0 0 1 6 16.5a2.25 2.25 0 0 1-1.68-2.45A2.25 2.25 0 0 1 3 12a2.25 2.25 0 0 1 1.32-2.05A2.25 2.25 0 0 1 6 7.5a2.25 2.25 0 0 1 2.05-1.32A2.25 2.25 0 0 1 12 3a2.25 2.25 0 0 1 3.95 1.18A2.25 2.25 0 0 1 18 7.5a2.25 2.25 0 0 1 1.68 2.45A2.25 2.25 0 0 1 21 12Z');
const ClipboardListIcon = svgIcon('M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25Z');
const UsersIcon = svgIcon('M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z');
const CircleStackIcon = svgIcon('M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125');
const EnvelopeIcon = svgIcon('M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75');
const CommandLineIcon = svgIcon('m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z');

/**
 * ESS-style user menu: an avatar-icon + name button that opens a dropdown with
 * Change password + Sign out. Hand-rolled (no @headlessui) to match the app's
 * dependency-light UI. Closes on Escape (via useFocusTrap), outside-click, or
 * selecting an item.
 */
function UserMenu({ name, roles, onLogout }: { name: string; roles: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useFocusTrap(open, menuRef, () => setOpen(false));

  // Close when clicking outside the menu container.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-ink-soft hover:bg-slate-100"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <UserCircleIcon className="h-7 w-7 text-ink-muted" />
        <span className="hidden text-left sm:block">
          <span className="block text-sm font-medium text-ink">{name}</span>
          <span className="block text-xs text-ink-muted">{roles || 'No roles'}</span>
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="User menu"
          className="absolute right-0 z-20 mt-2 w-56 origin-top-right overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg focus:outline-none"
        >
          <div className="border-b border-slate-100 px-4 py-3">
            <div className="truncate text-sm font-medium text-ink">{name}</div>
            <div className="truncate text-xs text-ink-muted">{roles || 'No roles'}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-ink-soft hover:bg-slate-50"
            onClick={() => {
              setOpen(false);
              navigate('/change-password');
            }}
          >
            <KeyIcon className="h-4 w-4 text-ink-muted" />
            Change password
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <SignOutIcon className="h-4 w-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

interface NavItem {
  label: string;
  to: string;
  icon: IconType;
  requires?: string;
}

const NAV: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: HomeIcon },
  { label: 'Library', to: '/library', icon: BookOpenIcon, requires: PERMISSIONS.DOCUMENT_READ },
  { label: 'Import', to: '/library/import', icon: ArrowUpTrayIcon, requires: PERMISSIONS.DOCUMENT_WRITE },
  { label: 'Notifications', to: '/notifications', icon: BellIcon },
  // Personal dashboard: any signed-in user may be assigned as a reviewer.
  { label: 'Reviews', to: '/reviews', icon: DocumentCheckIcon },
  // Personal dashboard: any signed-in user may be assigned to read and sign.
  { label: 'Acknowledgments', to: '/acknowledgments', icon: CheckBadgeIcon },
  { label: 'Audit Log', to: '/admin/audit', icon: ClipboardListIcon, requires: PERMISSIONS.AUDIT_READ },
  { label: 'Users', to: '/admin/users', icon: UsersIcon, requires: PERMISSIONS.USER_MANAGE },
  { label: 'Storage', to: '/admin/storage', icon: CircleStackIcon, requires: PERMISSIONS.STORAGE_MANAGE },
  { label: 'Email', to: '/admin/email', icon: EnvelopeIcon, requires: PERMISSIONS.SMTP_MANAGE },
  { label: 'API Clients', to: '/admin/api-clients', icon: CommandLineIcon, requires: PERMISSIONS.API_MANAGE },
];

function NavItems({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        return (
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
            <Icon className="h-5 w-5 shrink-0" />
            {item.label}
          </NavLink>
        );
      })}
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
  const unreadQuery = useQuery({
    queryKey: ['notification-unread-count'],
    queryFn: getUnreadNotificationCount,
    refetchInterval: 60_000,
    enabled: !!user,
  });
  const unread = unreadQuery.data?.unread ?? 0;

  const closeMobileNav = () => setMobileNavOpen(false);
  useFocusTrap(mobileNavOpen, drawerRef, closeMobileNav);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex h-16 shrink-0 items-center gap-2 border-b border-slate-200 px-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            PM
          </span>
          <span className="font-semibold text-ink">PolicyManager</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Primary">
          <NavItems items={visibleNav} />
        </nav>
        <div className="shrink-0 border-t border-slate-200 p-4 text-xs text-ink-muted">
          CARF / Joint Commission ready
        </div>
      </aside>

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
                X
              </button>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Primary">
              <NavItems items={visibleNav} onNavigate={closeMobileNav} />
            </nav>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 shadow-sm sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              className="rounded-md p-2 text-ink-soft hover:bg-slate-100 md:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileNavOpen}
              aria-controls="mobile-nav"
            >
              <span aria-hidden className="text-lg leading-none">
                Menu
              </span>
            </button>
            <div className="truncate text-sm text-ink-muted">
              Behavioral Health Document Management
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/notifications"
              className="relative rounded-md p-2 text-ink-muted hover:bg-slate-100 hover:text-ink-soft"
              aria-label={unread > 0 ? `${unread} unread notifications` : 'Notifications'}
            >
              <BellIcon className="h-6 w-6" />
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-red-600 px-1.5 text-center text-[10px] font-semibold leading-4 text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </Link>
            {user && (
              <UserMenu
                name={user.name}
                roles={user.roles.join(', ')}
                onLogout={() => void logout()}
              />
            )}
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
