import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMobileMenu } from '../context/MobileMenu';
import { apiFetch } from '../api.js';
import {
  BrandWordmark,
  IconHome,
  IconChat,
  IconMemory,
  IconGraph,
  IconDocument,
  IconPerson,
  IconChecklist,
  IconClock,
  IconSettings,
  IconWand,
  IconAutonomy,
  IconPlug,
  IconChevron,
  IconServer,
  IconBrain,
  IconPanelLeft,
  IconChannels,
  IconLink,
} from './Icons';
import { MoonrayMark } from './MoonrayMark';

type Theme = 'light' | 'system' | 'dark';

interface SidebarProps {
  activeView: string;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

const ROUTES: Record<string, string> = {
  dashboard: '/',
  chat:     '/chat',
  kg:       '/kg',
  documents: '/documents',
  contacts: '/contacts',
  tasks:    '/tasks',
  jobs:     '/jobs',
  tools: '/tools',
  agents:   '/agents',
  channels:   '/channels',
  connections: '/connections',
  'mcp-skills': '/mcp-skills',
  system:     '/system',
  settings:   '/settings',
};

const THEME_OPTIONS: Array<{ v: Theme; label: string }> = [
  { v: 'light', label: 'Light' },
  { v: 'system', label: 'Auto' },
  { v: 'dark', label: 'Dark' },
];

function ThemeToggle({ theme, onChange, compact }: { theme: Theme; onChange: (t: Theme) => void; compact: boolean }) {
  const options = THEME_OPTIONS;
  if (compact) {
    // Collapsed rail: one button that cycles Light → Auto → Dark.
    const i = Math.max(0, options.findIndex(o => o.v === theme));
    const current = options[i] ?? options[1]!;
    const next = options[(i + 1) % options.length] ?? options[0]!;
    return (
      <button
        type="button"
        className="theme-cycle-btn"
        onClick={() => onChange(next.v)}
        title={`${current.label} theme — switch to ${next.label}`}
        aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
      >
        {current.label}
      </button>
    );
  }
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {options.map((opt) => (
        <button
          key={opt.v}
          type="button"
          className={`theme-toggle-btn${theme === opt.v ? ' active' : ''}`}
          aria-pressed={theme === opt.v}
          onClick={() => onChange(opt.v)}
          title={`${opt.label} theme`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function getInitials(name: string | null): string {
  if (!name) return '···';
  const trimmed = name.trim();
  if (!trimmed) return '···';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return ((parts[0] ?? '')[0] ?? '').toUpperCase() + ((parts[parts.length - 1] ?? '')[0] ?? '').toUpperCase();
}

// Collapsed (icon rail) or expanded, remembered across pages and visits.
const COLLAPSED_KEY = 'curia.sidebar.collapsed';
const MOBILE_QUERY = '(max-width: 768px)';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    // Storage blocked (private mode, policy): start expanded.
    return false;
  }
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

interface NavButtonProps {
  label: string;
  icon: ReactNode;
  active?: boolean;
  sub?: boolean;
  collapsed: boolean;
  onClick: () => void;
  trailing?: ReactNode;
}

/** A nav row. Collapsed, it shows only the icon, with the label as its tooltip and name. */
function NavButton({ label, icon, active, sub, collapsed, onClick, trailing }: NavButtonProps) {
  return (
    <button
      className={`${sub ? 'nav-sub-item' : 'nav-item'}${active ? ' active' : ''}`}
      onClick={onClick}
      {...(collapsed ? { title: label, 'aria-label': label } : {})}
      {...(active ? { 'aria-current': 'page' as const } : {})}
    >
      {icon}
      <span className="nav-label">{label}</span>
      {!collapsed && trailing}
    </button>
  );
}

export function Sidebar({ activeView, theme, onThemeChange }: SidebarProps) {
  const [collapsedPref, setCollapsedPref] = useState(readCollapsed);
  // The mobile drawer always shows the full menu.
  const isMobile = useIsMobile();
  const collapsed = collapsedPref && !isMobile;
  const [memoryOpen, setMemoryOpen] = useState(true);
  // Expand the Settings group when on any of its pages (Skills/Agents are now
  // standalone pages but still live under the sidebar's Settings group).
  const [settingsOpen, setSettingsOpen] = useState(
    activeView === 'settings' || activeView === 'tools' || activeView === 'agents' || activeView === 'channels' || activeView === 'connections' || activeView === 'mcp-skills' || activeView === 'system',
  );
  const [principalName, setPrincipalName] = useState<string | null>(null);
  // Real Curia release version from GET /api/system. The build-time __APP_VERSION__
  // is the console package's own 0.0.x and does not track the app release; we only
  // fall back to it if the fetch fails.
  const [version, setVersion] = useState<string | null>(null);
  const { setOpen } = useMobileMenu();
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/contacts', { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`/api/contacts returned ${r.status}`);
        return r.json();
      })
      .then((data: { contacts: Array<{ displayName: string; systemRole?: string | null }> }) => {
        const principal = data.contacts.find(c => c.systemRole === 'principal');
        if (principal) setPrincipalName(principal.displayName);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Non-fatal: sidebar degrades to placeholders, but log so the cause is visible.
        console.error('[Sidebar] Failed to load principal contact:', err);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/system', { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`/api/system returned ${r.status}`);
        return r.json();
      })
      .then((data: { system?: { version?: string } }) => {
        if (typeof data.system?.version === 'string') setVersion(data.system.version);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Non-fatal: fall back to the build-time console version so the footer isn't blank.
        console.error('[Sidebar] Failed to load system version:', err);
        setVersion(__APP_VERSION__);
      });
    return () => controller.abort();
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsedPref(prev => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch (err) {
        console.error('[Sidebar] could not save the collapsed state:', err);
      }
      return next;
    });
  }, []);

  // ⌘\ / Ctrl+\ collapses or expands the sidebar from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '\\' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  const go = (view: string) => {
    const to = ROUTES[view];
    if (to) {
      navigate({ to }).catch((err: unknown) => {
        console.error(`[Sidebar] navigation to ${to} failed:`, err);
      });
    } else {
      console.error(`[Sidebar] go() called with unknown view key: "${view}"`);
    }
    setOpen(false);
  };

  const item = (view: string, label: string, icon: ReactNode, sub = false) => (
    <NavButton
      key={view}
      label={label}
      icon={icon}
      sub={sub && !collapsed}
      active={activeView === view}
      collapsed={collapsed}
      onClick={() => go(view)}
    />
  );

  const memoryItems = [
    item('kg', 'Knowledge Graph', <IconGraph />, true),
    item('documents', 'Documents', <IconDocument />, true),
    item('contacts', 'Contacts', <IconPerson />, true),
    item('tasks', 'Tasks', <IconChecklist />, true),
    item('jobs', 'Scheduled Jobs', <IconClock />, true),
  ];
  const settingsItems = [
    item('tools', 'Tools', <IconWand />, true),
    item('agents', 'Agents', <IconAutonomy />, true),
    item('channels', 'Channels', <IconChannels />, true),
    item('connections', 'API connections', <IconLink />, true),
    item('mcp-skills', 'MCP Skills', <IconPlug />, true),
    item('settings', 'Personality', <IconBrain />, true),
    item('system', 'System', <IconServer />, true),
  ];
  const toggleLabel = collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)';

  return (
    <nav className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Main">
      <div className="sidebar-head">
        <div className="sidebar-wordmark" aria-label="Moonray Ventures OS powered by Curia">
          {collapsed ? <MoonrayMark size={30} /> : <BrandWordmark />}
        </div>
        {!isMobile && (
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={toggleCollapsed}
            title={toggleLabel}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
          >
            <IconPanelLeft open={!collapsed} size={16} />
          </button>
        )}
      </div>

      <div className="nav-group">
        {item('dashboard', 'Home', <IconHome />)}
        {item('chat', 'Chat', <IconChat />)}

        {collapsed ? (
          // Icon rail: no group headers; each group's pages as icons, set apart by a divider.
          <>
            <div className="nav-divider" role="separator" />
            {memoryItems}
            <div className="nav-divider" role="separator" />
            {settingsItems}
          </>
        ) : (
          <>
            <div>
              <NavButton
                label="Memory"
                icon={<IconMemory />}
                collapsed={false}
                onClick={() => setMemoryOpen(!memoryOpen)}
                trailing={<IconChevron collapsed={!memoryOpen} />}
              />
              {memoryOpen && <div className="nav-subgroup">{memoryItems}</div>}
            </div>
            <div>
              <NavButton
                label="Settings"
                icon={<IconSettings />}
                collapsed={false}
                onClick={() => setSettingsOpen(!settingsOpen)}
                trailing={<IconChevron collapsed={!settingsOpen} />}
              />
              {settingsOpen && <div className="nav-subgroup">{settingsItems}</div>}
            </div>
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <ThemeToggle theme={theme} onChange={onThemeChange} compact={collapsed} />
        <button
          className="sidebar-user"
          {...(collapsed ? { title: `${principalName ?? 'Setting up…'}${version ? ` · v${version}` : ''}` } : {})}
        >
          <span className="sidebar-user-avatar">{getInitials(principalName)}</span>
          <span className="sidebar-user-meta">
            <span className="sidebar-user-name">{principalName ?? 'Setting up…'}</span>
            <span className="sidebar-user-org">{version ? `v${version}` : ''}</span>
          </span>
        </button>
      </div>
    </nav>
  );
}
