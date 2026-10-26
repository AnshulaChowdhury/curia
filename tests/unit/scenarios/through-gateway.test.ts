// Through-gateway runs (#2312): approvals, outreach and what was sent stay with the run that
// made them when runs overlap, a held send's approval is the one a follow-up "approve" resolves
// (Review Focus 4), and the run's rows are read before, and removed with, the run.
import { describe, expect, it, vi } from 'vitest';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { ActionLogRow, ResolveResult } from '../../../src/autonomy/action-log-types.js';
import { parseSenderVerified } from '../../../src/channels/email/message-converter.js';
import type { TaskOutreachRepo, TaskOutreachRow } from '../../../src/dispatch/task-outreach.js';
import type { TestModeStack } from '../../../src/startup/test-mode-stack.js';
import { createCaseContext, newAttempt, type CaseAttempt } from '../../shared/case-scope.js';
import { inboundNylasMessage } from '../../scenarios/harness.js';
import {
  cleanupRun,
  readGatewayOutcome,
  scopedActionLog,
  scopedOutreachRepo,
  SeedScope,
  SCENARIO_TASK_CREATOR,
  type SeededRun,
} from '../../scenarios/seed.js';
import type { ScenarioCase } from '../../scenarios/types.js';

type RunState = CaseAttempt & { scope: SeedScope };

function run(label: string, conversation: string): RunState {
  const scope = new SeedScope();
  scope.rootConversation = conversation;
  return { ...newAttempt(label), scope };
}

function row(overrides: Partial<ActionLogRow>): ActionLogRow {
  return {
    id: 1, taskId: 'task-event', conversationId: null, toolName: 'email-send', actionRisk: 'medium',
    outcome: 'pending_approval', shortRef: 'aaaa1111', approvalNumber: 1, description: 'Send Pat the quote',
    payload: {}, createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), notificationSentAt: new Date(),
    ...overrides,
  } as ActionLogRow;
}

describe('scopedActionLog: a follow-up approve acts on the run\'s own held send', () => {
  const context = createCaseContext<RunState>();
  const currentScope = () => context.current()?.scope;
  const mine = row({ id: 1, conversationId: 'scenario-a', shortRef: 'aaaa1111', approvalNumber: 3 });
  const other = row({ id: 2, conversationId: 'scenario-b', shortRef: 'bbbb2222', approvalNumber: 4 });
  const real = {
    findAllPending: vi.fn(async () => [mine, other]),
    resolvePending: vi.fn(async (ref?: string): Promise<ResolveResult> => {
      if (ref === 'aaaa1111' || ref === '3') return { found: true, row: mine };
      if (ref === 'bbbb2222' || ref === '4') return { found: true, row: other };
      return { found: false, reason: 'ambiguous', error: 'Multiple pending requests', pending: [mine, other] };
    }),
    insert: vi.fn(async () => 7),
  } as unknown as ActionLogRepo;
  const view = scopedActionLog(real, currentScope);

  it('resolves "approve" with no reference to the run\'s sole pending approval, not the table\'s', async () => {
    const result = await context.run(run('A', 'scenario-a'), () => view.resolvePending());
    expect(result).toEqual({ found: true, row: mine });
    // Through production's own lookup on that row, so its expiry checks still apply.
    expect(real.resolvePending).toHaveBeenLastCalledWith('aaaa1111');
  });

  it('resolves the run\'s approval by its number, and reads another run\'s as not found', async () => {
    expect(await context.run(run('A', 'scenario-a'), () => view.resolvePending('3'))).toEqual({ found: true, row: mine });
    const foreign = await context.run(run('A', 'scenario-a'), () => view.resolvePending('4'));
    expect(foreign.found).toBe(false);
    if (!foreign.found) expect(foreign.reason).toBe('not_found');
  });

  it('counts a specialist\'s conversation as the run\'s', async () => {
    const state = run('B', 'scenario-x');
    state.scope.specialistConversations.add('scenario-b');
    expect(await context.run(state, () => view.findAllPending())).toEqual([other]);
  });

  it('finds nothing outside every run, and writes as production does', async () => {
    expect(await view.findAllPending()).toEqual([]);
    expect((await view.resolvePending()).found).toBe(false);
    expect(await view.insert({ toolName: 'email-send', actionRisk: 'medium', outcome: 'pending_approval' } as never)).toBe(7);
  });
});

describe('scopedOutreachRepo: replies link only to the run\'s outreach', () => {
  const context = createCaseContext<RunState>();
  const currentScope = () => context.current()?.scope;
  const outreach = (id: string, extra: Partial<TaskOutreachRow>): TaskOutreachRow =>
    ({ id, taskId: null, conversationId: null, confirmed: true, domains: [], addresses: [], ...extra }) as TaskOutreachRow;
  const rows = [
    outreach('seeded', { taskId: null, conversationId: 'scenario-origin-outreach-x' }),
    outreach('by-task', { taskId: 'task-a' }),
    outreach('by-send', { conversationId: 'scenario-a' }),
    outreach('real', { conversationId: 'signal:+15555550199' }),
  ];
  const real = {
    findOpenByAddress: async () => rows,
    findOpenByContact: async () => rows,
    findOpenByDomain: async () => rows,
    findOpen: async () => rows,
  } as unknown as TaskOutreachRepo;
  const view = scopedOutreachRepo(real, currentScope);

  it('keeps the rows the run seeded, its tasks\' rows and its sends\' rows', async () => {
    const state = run('A', 'scenario-a');
    state.scope.seededOutreach.set('seeded', { domains: [], addresses: [] });
    state.scope.taskIds.add('task-a');
    const found = await context.run(state, () => view.findOpenByAddress('pat@vendor.example.test'));
    expect(found.map(r => r.id)).toEqual(['seeded', 'by-task', 'by-send']);
  });

  it('matches nothing for a run without outreach, or outside every run', async () => {
    expect(await context.run(run('B', 'scenario-b'), () => view.findOpenByDomain('vendor.example.test'))).toEqual([]);
    expect(await view.findOpen(10)).toEqual([]);
  });
});

/** A pool that answers each read by the table it names and records every statement. */
function fakeStack(answers: Record<string, unknown[]>) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      const table = Object.keys(answers).find(t => sql.includes(`FROM ${t}`) && sql.trim().startsWith('SELECT'));
      return { rows: table ? answers[table] : [], rowCount: 0 };
    }),
  };
  const stack = {
    pool,
    principalIdentities: [{ channel: 'signal', channelIdentifier: '+15555550111' }],
    contactService: { deleteContact: vi.fn(async () => {}) },
  } as unknown as TestModeStack;
  return { stack, statements };
}

const scenario = {
  seed: { contacts: [{ key: 'pat', identifier: 'pat@vendor.example.test' }] },
} as unknown as ScenarioCase;

function seededRun(extra: Partial<SeededRun> = {}): SeededRun {
  return {
    refs: new Map(), contacts: [], entryIds: [], threads: new Map(), verificationIds: [], principalIdentityIds: [],
    taskIds: ['task-a'], outreachIds: ['seeded'], ...extra,
  };
}

describe('readGatewayOutcome', () => {
  it('names recipients as the case does, joins each approval to what it shows, and drops untouched seeded outreach', async () => {
    const { stack } = fakeStack({
      autonomy_action_log: [{ short_ref: 'aaaa1111', approval_number: 3, tool_name: 'email-send', outcome: 'approved', description: 'Send Pat the quote' }],
      task_outreach: [
        { id: 'seeded', domains: ['vendor.example.test'], addresses: [], confirmed: true, via: 'email' },
        { id: 'new', domains: ['vendor.example.test'], addresses: ['pat@vendor.example.test'], confirmed: true, via: 'email' },
      ],
      disclosure_decisions: [{ label: 'SIN', decision: 'yes' }],
    });
    const scope = new SeedScope();
    scope.rootConversation = 'scenario-a';
    scope.seededOutreach.set('seeded', { domains: ['vendor.example.test'], addresses: [] });
    scope.deliveries.push(
      { channel: 'email', kind: 'send', to: ['PAT@vendor.example.test'], cc: [], subject: 'Quote', body: 'Hi', id: 'm1' },
      { channel: 'signal', kind: 'send', to: ['+15555550111'], cc: [], body: 'Approval 3', id: 'm2' },
    );
    scope.approvalDisplays.set('aaaa1111', { preamble: 'Pat asked for your SIN. Share it?', payload: {}, extraLines: ['Reason: personal data'] });

    const outcome = await readGatewayOutcome(stack, scenario, seededRun(), scope);
    expect(outcome.deliveries.map(d => d.toNames)).toEqual([['pat'], ['principal']]);
    expect(outcome.holds).toEqual([{
      shortRef: 'aaaa1111', approvalNumber: 3, toolName: 'email-send', outcome: 'approved', description: 'Send Pat the quote',
      preamble: 'Pat asked for your SIN. Share it?', extraLines: ['Reason: personal data'],
    }]);
    expect(outcome.outreach).toEqual([{ domains: ['vendor.example.test'], addresses: ['pat@vendor.example.test'], confirmed: true, via: 'email', seeded: false }]);
    expect(outcome.decisions).toEqual([{ label: 'SIN', decision: 'yes' }]);
  });
});

describe('cleanupRun: what through-gateway sends wrote', () => {
  it('removes the run\'s approvals, decisions and outreach by its conversations, then its seeded rows', async () => {
    const { stack, statements } = fakeStack({});
    const scope = new SeedScope();
    scope.specialistConversations.add('scenario-delegate-1');
    await cleanupRun(stack, seededRun(), scope, 'scenario-a');
    const deletes = statements.filter(s => s.sql.trim().startsWith('DELETE'));
    const on = (table: string) => deletes.filter(s => s.sql.includes(`DELETE FROM ${table} `));
    for (const table of ['autonomy_action_log', 'disclosure_decisions']) {
      expect(on(table).map(s => s.params[0]), table).toEqual([['scenario-a', 'scenario-delegate-1']]);
    }
    expect(on('task_outreach').map(s => s.params[0])).toEqual([['scenario-a', 'scenario-delegate-1'], ['seeded']]);
    // Only rows the suite made: the creator marker guards a task delete.
    expect(on('tasks')).toEqual([{ sql: expect.stringContaining('created_by = $2'), params: [['task-a'], SCENARIO_TASK_CREATOR] }]);
  });
});

describe('inboundNylasMessage', () => {
  it('passes authentication only when the case says the sender was verified', () => {
    const verified = inboundNylasMessage('scenario-msg-1', 'pat@vendor.example.test', { content: 'Hi', email: { senderVerified: true } }, undefined);
    expect(parseSenderVerified(verified.headers)).toBe(true);
    expect(verified.to).toEqual([{ email: 'curia@example.test' }]);
    const unverified = inboundNylasMessage('scenario-msg-2', 'pat@vendor.example.test', { content: 'Hi' }, { to: ['curia@example.test'], cc: ['lee@vendor.example.test'] });
    expect(parseSenderVerified(unverified.headers)).toBe(false);
    expect(unverified.cc).toEqual([{ email: 'lee@vendor.example.test' }]);
  });
});

describe('seedRun: the seeds a through-gateway case needs', () => {
  it('grants trusted after creation, writes a standing task with its originator and an outreach row, and scopes both', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        if (sql.includes('INSERT INTO kg_nodes')) return { rows: [{ id: 'node-1' }] };
        if (sql.includes('INSERT INTO tasks')) return { rows: [{ id: 'task-1' }] };
        if (sql.includes('INSERT INTO task_outreach')) return { rows: [{ id: 'outreach-1', domains: ['vendor.example.test'], addresses: [] }] };
        return { rows: [] };
      }),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn(async () => null),
      createContact: vi.fn(async () => ({ id: 'contact-1' })),
      linkIdentity: vi.fn(async () => {}),
      setTier: vi.fn(async () => ({})),
    };
    const stack = { pool, contactService, principalContactId: 'principal-1' } as unknown as TestModeStack;
    const scope = new SeedScope();
    const { seedRun } = await import('../../scenarios/seed.js');
    const c = {
      seed: {
        contacts: [{ key: 'pat', displayName: 'Pat Okafor', tier: 'trusted', channel: 'email', identifier: 'pat@vendor.example.test' }],
        outboundContext: [], bullpen: [], verifications: [], principalIdentities: [],
        tasks: [{ key: 'onboarding', title: 'Vendor forms', originator: 'principal', agent: 'coordinator' }],
        outreach: [{ key: 'forms', task: 'onboarding', via: 'email', domains: ['vendor.example.test'], addresses: [], contacts: ['pat'], summary: 'Sent forms', confirmed: true }],
      },
    } as unknown as ScenarioCase;

    const seeded = await seedRun(c, { stack, outboundContext: {} as never, scope });
    expect(contactService.createContact).toHaveBeenCalledWith(expect.objectContaining({ tier: 'known' }));
    expect(contactService.setTier).toHaveBeenCalledWith('contact-1', 'trusted');
    const task = statements.find(s => s.sql.includes('INSERT INTO tasks'))!;
    expect(task.params[4]).toBe(SCENARIO_TASK_CREATOR);
    expect(JSON.parse(task.params[5] as string)).toMatchObject({ contactId: 'principal-1', systemRole: 'principal', tier: 'principal', authenticated: true });
    const outreach = statements.find(s => s.sql.includes('INSERT INTO task_outreach'))!;
    expect(outreach.params[0]).toBe('task-1');
    expect(outreach.params[7]).toEqual(['contact-1']);
    expect(seeded.refs.get('task:onboarding')).toBe('task-1');
    expect(seeded.refs.get('outreach:forms')).toBe('outreach-1');
    expect([...scope.taskIds]).toEqual(['task-1']);
    expect([...scope.seededOutreach.keys()]).toEqual(['outreach-1']);
  });
});
