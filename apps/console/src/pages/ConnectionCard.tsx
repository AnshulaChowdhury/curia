import { useId, useState, type ReactNode } from 'react';
import { IconChevron } from '../components/Icons.js';

interface ConnectionCardProps {
  /** Heading content, including any status pill; stays visible when the card is collapsed. */
  title: ReactNode;
  sub: string;
  children: ReactNode;
}

/** A settings card that starts collapsed and expands when its header is clicked. */
export default function ConnectionCard({ title, sub, children }: ConnectionCardProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <section className="settings-section">
      <button
        type="button"
        className={`settings-section-head connection-card-toggle${open ? '' : ' is-collapsed'}`}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(o => !o)}
      >
        <span className="connection-card-heading">
          <span className="settings-section-title">{title}</span>
          <span className="settings-section-sub">{sub}</span>
        </span>
        <IconChevron collapsed={!open} />
      </button>
      <div id={bodyId} hidden={!open}>{children}</div>
    </section>
  );
}
