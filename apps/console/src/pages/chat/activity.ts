// What the assistant is doing, in words, taken from the tools it actually runs (the chat stream's progress events),
// never from what it says about itself.

export interface Step {
  id: number;
  agent: string;
  tool: string;
  delegateTo?: string;
  state: 'running' | 'done' | 'failed';
}

/** The turn in progress: when it began, and each tool run so far. */
export interface Work { startedAt: number; steps: Step[] }

const COORDINATOR = 'coordinator';

/** [while it runs, once it has] for tools worth naming; matched exactly first, then by prefix. */
const NAMED: Record<string, [string, string]> = {
  'budget-sheet-read': ['Reading your spreadsheet', 'Read your spreadsheet'],
  'budget-propose': ['Preparing proposed changes', 'Prepared proposed changes'],
  'email-send': ['Sending an email', 'Sent an email'],
  'email-reply': ['Replying to an email', 'Replied to an email'],
};
const PREFIXED: Array<[RegExp, [string, string]]> = [
  [/^budget-/, ['Checking your budget', 'Checked your budget']],
  [/^books-/, ['Checking the company books', 'Checked the company books']],
  [/^email-/, ['Working with email', 'Worked with email']],
  [/^calendar-/, ['Working with your calendar', 'Worked with your calendar']],
  [/^contact/, ['Looking up contacts', 'Looked up contacts']],
  [/^web-/, ['Searching the web', 'Searched the web']],
  [/^(memory|knowledge|entity|kg)-/, ['Checking saved information', 'Checked saved information']],
];

/** "ceo-inbox" as "Ceo inbox". */
export function agentName(name: string): string {
  const words = name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function phrases(step: Pick<Step, 'tool' | 'delegateTo'>): [string, string] {
  if (step.tool === 'delegate') {
    const who = step.delegateTo ? `the ${agentName(step.delegateTo).toLowerCase()} agent` : 'a specialist';
    return [`Asking ${who}`, `Asked ${who}`];
  }
  const words = step.tool.replace(/[-.]/g, ' ');
  return NAMED[step.tool] ?? PREFIXED.find(([pattern]) => pattern.test(step.tool))?.[1] ?? [`Using ${words}`, `Used ${words}`];
}

export function describeStep(step: Step): string {
  const [doing, done] = phrases(step);
  const text = step.state === 'done' ? done : step.state === 'failed' ? `${doing}: did not work` : doing;
  return step.agent && step.agent !== COORDINATOR ? `${agentName(step.agent)} agent: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/** The one line beside the loader: the latest thing still running, else what comes between tools. */
export function headline(steps: Step[]): string {
  const running = [...steps].reverse().find(s => s.state === 'running');
  if (running) return describeStep(running);
  return steps.length === 0 ? 'Thinking' : 'Writing the reply';
}

export function startStep(steps: Step[], event: { agent: string; tool: string; delegateTo?: string }): Step[] {
  const { agent, tool, delegateTo } = event;
  return [...steps, { id: steps.length, agent, tool, ...(delegateTo ? { delegateTo } : {}), state: 'running' }];
}

/** Marks the latest running step of that agent and tool as finished. */
export function endStep(steps: Step[], event: { agent: string; tool: string; ok: boolean }): Step[] {
  const found = [...steps].reverse().find(s => s.state === 'running' && s.agent === event.agent && s.tool === event.tool);
  if (!found) return steps;
  return steps.map(s => (s === found ? { ...s, state: event.ok ? 'done' : 'failed' } : s));
}

/** The record left in the thread once the turn ends. A step with no result keeps its "doing" wording. */
export function trace(steps: Step[]): string[] {
  return steps.map(s => `${s.state === 'done' ? '✓ ' : s.state === 'failed' ? '✕ ' : '• '}${describeStep(s)}`);
}

/** "0:07", "2:05". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
