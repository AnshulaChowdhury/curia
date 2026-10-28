import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { useTheme } from '../hooks/useTheme.js';
import { ChatThread } from './chat/ChatThread.js';
import { ChatComposer } from './chat/ChatComposer.js';
import { useChatSession } from './chat/useChatSession.js';
import { useVoiceCall } from './chat/useVoiceCall.js';
import { VoiceCallBar } from './chat/VoiceCallBar.js';

// One token per Ask Curia submit. Survives a strict-mode remount so the
// question is sent once, and a new token lets the same text be asked again.
const sentAskTokens = new Set<string>();

function useDashboardQuestion(send: (text: string) => Promise<void>): void {
  const search = useSearch({ strict: false }) as { q?: string; t?: string };
  const navigate = useNavigate();
  const sendRef = useRef(send);
  sendRef.current = send;
  const q = search.q;
  const t = search.t;
  useEffect(() => {
    const text = (q ?? '').trim();
    if (!text || !t || sentAskTokens.has(t)) return;
    sentAskTokens.add(t);
    void sendRef.current(text).finally(() => {
      void navigate({ to: '/chat', search: {}, replace: true });
    });
  }, [q, t, navigate]);
}

export default function ChatPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { messages, sending, hasMore, loadingHistory, send, loadMore } = useChatSession();
  const voiceCall = useVoiceCall();
  useDashboardQuestion(send);

  useEffect(() => {
    if (mobileOpen) {
      document.documentElement.dataset['mobileSidebar'] = 'open';
    } else {
      delete document.documentElement.dataset['mobileSidebar'];
    }
    return () => { delete document.documentElement.dataset['mobileSidebar']; };
  }, [mobileOpen]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="chat" theme={theme} onThemeChange={setTheme} />
        <main className="main">
          <Topbar crumb="Curia" title="Chat" />
          <div className="chat-page">
            <ChatThread
              messages={messages}
              hasMore={hasMore}
              loadingHistory={loadingHistory}
              loadMore={loadMore}
            />
            <div className="chat-input-area">
              <VoiceCallBar {...voiceCall} />
              <ChatComposer disabled={sending} onSend={send} />
            </div>
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
