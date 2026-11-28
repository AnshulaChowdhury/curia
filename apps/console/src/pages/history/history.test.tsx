import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conversationTitle, defaultFilters, detailBlocks, listPath, read, stepsPath, type Conversation } from './history-client.js';
import { ConversationRows, DetailView, StepRows } from './HistoryViews.js';

const conversation: Conversation = {
  id: 'c1', title: 'Plan the month', startedAt: '2031-03-01T10:00:00Z', lastAt: '2031-03-01T10:05:00Z',
  events: 9, errors: 1, agents: ['coordinator', 'budget'], channels: ['web'], costUsd: 0.25,
};

describe('history requests', () => {
  const filters = { from: '2031-03-01', to: '2031-03-07', agent: '', channel: '', errorsOnly: false };
  const paramsOf = (path: string) => new URL(path, 'http://x').searchParams;

  it('starts on the last seven days, today included', () => {
    expect(defaultFilters(new Date(2031, 2, 7, 12))).toEqual(filters);
  });
  it('asks for whole local days, the last one included', () => {
    const params = paramsOf(listPath(filters, 0));
    expect(params.get('from')).toBe(new Date(2031, 2, 1).toISOString());
    expect(params.get('to')).toBe(new Date(2031, 2, 8).toISOString());
    expect([...params.keys()]).toEqual(['from', 'to']);
  });
  it('sends only the chosen filters', () => {
    const params = paramsOf(listPath({ ...filters, agent: 'budget', channel: 'web', errorsOnly: true }, 50));
    expect(['agent', 'channel', 'errors', 'offset'].map(k => params.get(k))).toEqual(['budget', 'web', '1', '50']);
  });
  it('names a conversation, and none for activity outside one', () => {
    expect(paramsOf(stepsPath(filters, 'a/b', '12')).get('conversation')).toBe('a/b');
    expect(paramsOf(stepsPath(filters, null)).has('conversation')).toBe(false);
  });
  it('reports the server’s message when a read fails', async () => {
    await expect(read('/x', async () => new Response(JSON.stringify({ error: 'from must be before to' }), { status: 400 }))).rejects.toThrow('from must be before to');
    await expect(read('/x', async () => new Response('nope', { status: 502 }))).rejects.toThrow('502');
  });
});

describe('history wording', () => {
  it('titles what has no message', () => {
    expect(conversationTitle({ ...conversation, title: '', id: null })).toContain('outside any conversation');
    expect(conversationTitle({ ...conversation, title: '', id: 'system' })).toContain('Background AI calls');
  });
  it('lays a tool call out as input and output, then the full record', () => {
    const blocks = detailBlocks({ payload: { toolName: 't', input: { months: 3 } }, result: { result: { success: true } }, archive: null, notes: [] });
    expect(blocks.map(b => b.heading)).toEqual(['Input', 'Output', 'Full record']);
  });
  it('puts an AI call’s prompt and reply first', () => {
    const blocks = detailBlocks({ payload: { actualModel: 'm' }, result: null, archive: { prompt: 'p', response: 'r', toolDefinitions: null }, notes: [] });
    expect(blocks.map(b => b.heading)).toEqual(['Prompt', 'Reply', 'Full record']);
  });
});

describe('history views', () => {
  it('lists a conversation with its agents, cost and errors', () => {
    const html = renderToStaticMarkup(createElement(ConversationRows, { conversations: [conversation], onOpen: () => {} }));
    for (const part of ['Plan the month', 'coordinator, budget', '9 steps', '$0.25', '1 error']) expect(html).toContain(part);
  });
  it('does not round a small cost to nothing', () => {
    const html = renderToStaticMarkup(createElement(ConversationRows, { conversations: [{ ...conversation, costUsd: 0.0042 }], onOpen: () => {} }));
    expect(html).toContain('under $0.01');
  });
  it('indents a specialist’s steps and marks failures', () => {
    const step = { id: 's', seq: '1', at: '2031-03-01T10:00:00Z', type: 'tool.invoke', agent: 'budget', depth: 1, label: 'Tool: budget-plan', preview: '{}', failed: true };
    const html = renderToStaticMarkup(createElement(StepRows, { steps: [step], open: new Set<string>(), onToggle: () => {}, detail: () => null }));
    expect(html).toContain('margin-left:20px');
    expect(html).toContain('failed');
  });
  it('shows recorded text as text, never as markup, and says what is missing', () => {
    const html = renderToStaticMarkup(createElement(DetailView, { detail: { payload: { content: '<img src=x onerror=alert(1)>' }, result: null, archive: null, notes: ['No result was recorded for this call.'] } }));
    expect(html).not.toContain('<img');
    expect(html).toContain('No result was recorded');
  });
});
