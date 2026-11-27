import { useState, useEffect } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { MoonrayRings } from '../components/MoonrayRings.js';
import { useTheme } from '../hooks/useTheme.js';
import { ChatThread } from './chat/ChatThread.js';
import { ChatComposer } from './chat/ChatComposer.js';
import { useChatSession } from './chat/useChatSession.js';
import { useVoiceCall } from './chat/useVoiceCall.js';
import { VoiceCallBar } from './chat/VoiceCallBar.js';
import { useHandedOffQuestion } from './chat/ask-handoff.js';
import { loadedAsChatPage, useChatSheet } from './chat/useChatSheet.js';
import { AttachButton, SheetBar, SheetSide } from './chat/ChatSheet.js';
import { isApproval, useBudgetProposal } from './chat/useBudgetProposal.js';
import { ProposalCard } from './chat/ProposalCard.js';

export default function ChatPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { messages, sending, hasMore, loadingHistory, send, loadMore, conversationId, ensureConversationId } = useChatSession();
  const attachment = useChatSheet(conversationId, ensureConversationId);
  const [sheetOpen, setSheetOpen] = useState(true);
  const framing = loadedAsChatPage(performance.getEntriesByType('navigation')[0]?.name);
  const askedToAttach = new URLSearchParams(window.location.search).has('attach');
  const shown = attachment.sheet ?? attachment.leaving;
  const voiceCall = useVoiceCall();
  useHandedOffQuestion(send);
  const changes = useBudgetProposal(conversationId, sending);
  // "yes" while a proposal is on screen approves it here, without going through the assistant.
  const say = (text: string) => { if (changes.proposal && isApproval(text)) void changes.apply(); else send(text); };

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
          <Topbar crumb="Moonray Ventures OS" title="Chat" />
          <div className={`chat-split${framing && attachment.sheet && sheetOpen ? ' has-sheet' : ''}`}>
            <div className="chat-page">
              <MoonrayRings />
              <ChatThread
                messages={messages}
                hasMore={hasMore}
                loadingHistory={loadingHistory}
                loadMore={loadMore}
              />
              <div className="chat-input-area">
                <VoiceCallBar {...voiceCall} />
                <ProposalCard proposal={changes.proposal} outcome={changes.outcome} error={changes.error} busy={changes.busy}
                  onApply={() => void changes.apply()} onDiscard={() => void changes.discard()} onDismiss={changes.dismiss} />
                <SheetBar sheet={attachment.sheet} ready={framing} open={sheetOpen} busy={attachment.busy} error={attachment.error}
                  hint={askedToAttach} onToggle={() => setSheetOpen(o => !o)} onDetach={() => void attachment.detach()} />
                <ChatComposer disabled={sending} onSend={say}
                  attach={<AttachButton ready={framing} busy={attachment.busy} onFile={f => { setSheetOpen(true); void attachment.add(f); }} />} />
              </div>
            </div>
            {framing && shown && <SheetSide sheet={shown} hidden={!attachment.sheet || !sheetOpen} />}
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
