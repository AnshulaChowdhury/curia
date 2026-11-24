import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { useTheme } from '../hooks/useTheme.js';
import type { BudgetLoad } from './budget-data.js';

const TABS: Array<{ to: '/budget' | '/budget/budgets'; label: string }> = [
  { to: '/budget', label: 'Overview' },
  { to: '/budget/budgets', label: 'Budgets' },
];

/** Layout shared by the budget pages: sidebar, topbar, and a tab bar. Transactions, Import and Rules join the tabs later. */
export function BudgetShell({ active, children }: { active: string; children: ReactNode }) {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="budget" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
        <main className="main">
          <Topbar title="Budget" />
          <nav className="bud-tabs" aria-label="Budget sections">
            {TABS.map(t => (
              <Link
                key={t.to}
                to={t.to}
                className={`bud-tab${active === t.to ? ' is-active' : ''}`}
                aria-current={active === t.to ? 'page' : undefined}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="bud-body">
            <p className="bud-fixture-note" role="note">
              Sample data only. Nothing here is real, and nothing is saved when you reload.
            </p>
            {children}
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}

/** Shown when the server answers 401 or 403, or fails. Never renders partial data. */
export function BudgetGate({ load }: { load: BudgetLoad | null }) {
  if (!load) return <p className="dash-card-quiet" role="status">Loading…</p>;
  if (load.state === 'locked') {
    return (
      <div className="dash-card" role="alert">
        <h3 className="dash-card-title">Locked</h3>
        <p className="dash-card-quiet">Budget data is private to the owner. Sign in as the owner to see it.</p>
      </div>
    );
  }
  if (load.state === 'error') {
    return <div className="dash-card" role="alert"><p className="dash-card-quiet">{load.message}</p></div>;
  }
  return null;
}
