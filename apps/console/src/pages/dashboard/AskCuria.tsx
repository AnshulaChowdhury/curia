// Inline question. Submitting opens chat and sends the text once.

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { handOffQuestion } from '../chat/ask-handoff.js';

export function AskCuria() {
  const [text, setText] = useState('');
  const navigate = useNavigate();

  return (
    <form
      className="dash-card dash-ask-card"
      onSubmit={(event) => {
        event.preventDefault();
        const q = text.trim();
        if (!q) return;
        handOffQuestion(q);
        void navigate({ to: '/chat' });
      }}
    >
      <div className="dash-card-title">Ask Curia</div>
      <div className="dash-ask-row">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What did I commit to in last week's board call?"
          aria-label="Ask Curia"
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={text.trim().length === 0}>Ask</button>
      </div>
    </form>
  );
}
