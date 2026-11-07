import { Link, NavLink, Outlet } from 'react-router-dom';

import { LivePill } from './LivePill';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', index: '01', end: true },
  { to: '/sessions', label: 'Flight log', index: '02', end: false },
  { to: '/guards', label: 'Guards', index: '03', end: false },
  { to: '/debt', label: 'Understanding', index: '04', end: false },
  { to: '/analytics', label: 'Analytics', index: '05', end: false },
  { to: '/brain', label: 'Project Brain', index: '06', end: false },
  { to: '/arena', label: 'Model Arena', index: '07', end: false },
  { to: '/journal', label: 'Journal', index: '08', end: false },
  { to: '/plugins', label: 'Plugins', index: '09', end: false },
  { to: '/pair', label: 'Pair a device', index: '10', end: false },
] as const;

export function AppShell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className="rail">
        <div className="rail-inner">
          <Link className="brand" to="/" aria-label="Cockpit overview">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 40 40" role="presentation" focusable="false">
                <circle cx="20" cy="20" r="15.5" fill="none" stroke="currentColor" />
                <circle cx="20" cy="20" r="8" fill="none" stroke="currentColor" />
                <path d="M20 2v6M20 32v6M2 20h6M32 20h6" stroke="currentColor" />
                <path d="M20 20l7-7" stroke="currentColor" />
                <circle cx="20" cy="20" r="2.5" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <span className="brand-copy">
              <span className="brand-name">Cockpit</span>
              <span className="brand-tag">Flight recorder</span>
            </span>
          </Link>

          <nav className="rail-nav" aria-label="Primary">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
              >
                <span className="rail-index" aria-hidden="true">
                  {item.index}
                </span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="rail-rule" aria-hidden="true" />

          <div className="rail-note">
            <p>Local daemon. Your prompts stay on this machine.</p>
            <p className="rail-technical">Zero telemetry · SQLite</p>
          </div>
        </div>

        <div className="rail-foot">
          <LivePill />
          <p>Recorded locally, for you.</p>
        </div>
      </aside>

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
