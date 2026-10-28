// filter.llmJudge and pii.outbound_redaction resolve the same way for production and the
// test-mode recording stack (#2312), with production's validation.
import { describe, expect, it, vi } from 'vitest';
import { OutboundConfigError, resolveOutboundJudgeConfig, resolveOutboundRedactionConfig, type YamlConfig } from '../../src/config.js';

describe('resolveOutboundJudgeConfig', () => {
  it('applies the defaults', () => {
    expect(resolveOutboundJudgeConfig(undefined)).toEqual({ enabled: true, model: 'claude-haiku-5-5', timeoutMs: 5000, failMode: 'split' });
  });

  it('reads overrides', () => {
    expect(resolveOutboundJudgeConfig({ llmJudge: { enabled: false, model: 'm', timeout_ms: 900, failMode: 'closed' } }))
      .toEqual({ enabled: false, model: 'm', timeoutMs: 900, failMode: 'closed' });
  });

  it.each([0, -5, 249, 1000.5])('refuses timeout_ms %s on an enabled judge', (timeout) => {
    expect(() => resolveOutboundJudgeConfig({ llmJudge: { timeout_ms: timeout } })).toThrow(OutboundConfigError);
  });

  it('does not check the timeout of a disabled judge', () => {
    expect(resolveOutboundJudgeConfig({ llmJudge: { enabled: false, timeout_ms: 0 } }).enabled).toBe(false);
  });

  it('warns on an unknown failMode and uses split', () => {
    const warn = vi.fn();
    expect(resolveOutboundJudgeConfig({ llmJudge: { failMode: 'maybe' } } as unknown as YamlConfig['filter'], warn).failMode).toBe('split');
    expect(warn).toHaveBeenCalledWith({ failMode: 'maybe' }, expect.stringMatching(/failMode/));
  });

  it('does not check the failMode of a disabled judge', () => {
    const warn = vi.fn();
    resolveOutboundJudgeConfig({ llmJudge: { enabled: false, failMode: 'maybe' } } as unknown as YamlConfig['filter'], warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('resolveOutboundRedactionConfig', () => {
  it('blocks by default, enabled, with no channel policies', () => {
    expect(resolveOutboundRedactionConfig(undefined)).toEqual({ enabled: true, default: 'block', channel_policies: {} });
  });

  it('fills each channel\'s allow list', () => {
    expect(resolveOutboundRedactionConfig({ outbound_redaction: { enabled: false, default: 'allow', channel_policies: { email: {}, signal: { allow: ['phone'] } } } }))
      .toEqual({ enabled: false, default: 'allow', channel_policies: { email: { allow: [] }, signal: { allow: ['phone'] } } });
  });

  it('warns on an unknown default and blocks', () => {
    const warn = vi.fn();
    expect(resolveOutboundRedactionConfig({ outbound_redaction: { default: 'redact' } } as unknown as YamlConfig['pii'], warn).default).toBe('block');
    expect(warn).toHaveBeenCalledWith({ default: 'redact' }, expect.stringMatching(/default/));
  });
});
