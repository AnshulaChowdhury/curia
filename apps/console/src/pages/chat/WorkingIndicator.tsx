// Shown while a reply is on its way: the Moonray loader, what is running now, how long it has been, and each step so far.

import { useEffect, useState } from 'react';
import { AnimatedMoonrayMark } from '../../components/Icons.js';
import { describeStep, elapsed, headline, type Work } from './activity.js';

export function WorkingIndicator({ work }: { work: Work }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="chat-working">
      <div className="chat-working-head">
        <AnimatedMoonrayMark size={44} aria-hidden="true" role="presentation" />
        <span className="chat-working-now" role="status">{headline(work.steps)}…</span>
        {/* Not announced: a screen reader would hear every second. */}
        <span className="chat-working-time" aria-hidden="true">{elapsed(now - work.startedAt)}</span>
      </div>
      {work.steps.length > 0 && (
        <ul className="chat-working-steps">
          {work.steps.map(step => (
            <li key={step.id} className={`is-${step.state}`}>{describeStep(step)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
