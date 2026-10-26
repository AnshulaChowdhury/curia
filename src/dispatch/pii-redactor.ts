// pii-redactor.ts — channel-aware PII redactor for outbound messages.
//
// Sits between the agent response and the channel adapter. For each outbound
// message it:
//   1. Checks whether the kill switch is active (enabled: false → pass through)
//   2. Checks principalIsSoleRecipient — the principal is the only human recipient of the
//      send, computed by the gateway from verified principal identities across every To/CC
//      recipient (silent bypass). A third party sharing the send disables it (#2312).
//   3. Detects PII using the shared detectPii() core from src/pii/scrubber.ts
//   4. Filters matches to those not in the channel's allow list
//   5. Replaces them end-to-start with labelled tokens (e.g. [REDACTED: CREDIT_CARD])
//   6. Fires an audit bus event (fire-and-forget with .catch(warn))
//
// Fail-closed: this class does NOT swallow its own errors. The caller (OutboundGateway
// in Task 8) is responsible for catching and deciding whether to block delivery.

import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { PiiPattern } from '../pii/scrubber.js';
import { detectPii } from '../pii/scrubber.js';
import { createOutboundPiiRedacted } from '../bus/events.js';

// -- Config shape (mirrors the outbound_redaction block from YamlConfig) --

export interface OutboundRedactionConfig {
  /** Kill switch. When false, all redaction is bypassed. */
  enabled: boolean;
  /** Default action for channels / patterns not in channel_policies. */
  default: 'block' | 'allow';
  /** Per-channel policy: labels listed here are allowed through unredacted. */
  channel_policies: Record<string, { allow: string[] }>;
}

// -- Public result types --

/**
 * A single redaction that was applied to the message.
 * Intentionally does NOT store the original matched value — only what it was replaced with.
 */
export interface RedactionEntry {
  /** Pattern label in lowercase (e.g. "credit_card", "email"). */
  patternLabel: string;
  /** Channel the message was routed through. */
  channelId: string;
  /** The replacement token that was inserted (e.g. "[REDACTED: CREDIT_CARD]"). */
  replacedWith: string;
}

/** A PII span detect() found that channel policy says to redact. Carries the matched text. */
export interface DetectedPii {
  /** Pattern label as the scrubber reports it. */
  label: string;
  /** Start offset in the content passed to detect(). */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** The matched text. Never log or publish it. */
  matched: string;
}

/** Result of a redact() or apply() call. */
export interface RedactionResult {
  /** The content with PII replaced (or the original if nothing was redacted). */
  content: string;
  /** List of applied redactions. Empty when nothing was redacted. */
  redactions: RedactionEntry[];
}

// -- Constructor options --

export interface PiiRedactorOptions {
  config: OutboundRedactionConfig;
  bus: EventBus;
  logger: Logger;
  /** Extra patterns from config (loaded once at startup and threaded through). */
  extraPatterns: PiiPattern[];
}

// -- Optional context for audit event --

export interface RedactContext {
  conversationId?: string;
  recipientId?: string;
  parentEventId?: string;
  /**
   * True only when the principal is the sole human recipient of the send. The gateway computes
   * it from the verified principal identities over every To and CC recipient, so a third party
   * on the same send keeps it false. Redaction is bypassed iff this is exactly `true`.
   */
  principalIsSoleRecipient?: boolean;
}

// -- PiiRedactor class --

export class PiiRedactor {
  private readonly config: OutboundRedactionConfig;
  private readonly bus: EventBus;
  private readonly logger: Logger;
  private readonly extraPatterns: PiiPattern[];

  constructor(opts: PiiRedactorOptions) {
    this.config = opts.config;
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.extraPatterns = opts.extraPatterns;
  }

  /**
   * Detect the PII in outbound content that channel policy would redact.
   *
   * Returns [] if redaction is disabled (kill switch), the principal is the sole recipient
   * (context.principalIsSoleRecipient === true), no PII is found, or everything found is in the
   * channel's allow list. Items are in start-offset order. Pure: logs and publishes nothing.
   *
   * @param content    The outbound message content.
   * @param channelId  The destination channel (e.g. 'email', 'signal').
   * @param context    Optional context; only principalIsSoleRecipient is read here.
   */
  detect(
    content: string,
    channelId: string,
    context: RedactContext = {},
  ): DetectedPii[] {
    // Step 1: Kill switch — if disabled, pass through without any inspection.
    if (!this.config.enabled) {
      return [];
    }

    // Step 2: principal bypass — the principal is the only human recipient. The gateway derives
    // this from verified principal identities across every To/CC recipient, so "To: principal,
    // CC: third party" is NOT a bypass (#2312). Strict `=== true`: absent or false redacts.
    if (context.principalIsSoleRecipient === true) {
      return [];
    }

    // Step 3: Detect PII using the shared scrubber core.
    const matches = detectPii(content, this.extraPatterns);
    if (matches.length === 0) {
      return [];
    }

    // Step 4: Build the allow set for this channel (lowercase comparison).
    // If the channel is not in channel_policies, fall back to the default action.
    const channelPolicy = this.config.channel_policies[channelId];
    const allowSet = new Set(
      (channelPolicy?.allow ?? []).map((label) => label.toLowerCase()),
    );

    // If default is 'allow' and the channel has no explicit policy, everything is allowed.
    // If default is 'block' and the channel has no explicit policy, all PII is blocked.
    // Filter to matches that are NOT in the allow set.
    return matches
      .filter((m) => {
        const label = m.label.toLowerCase();
        if (allowSet.has(label)) {
          // Explicitly allowed on this channel — pass through.
          return false;
        }
        // Not in the allow list — check the default action.
        // 'block' → redact; 'allow' → pass (but only for channels without an explicit policy).
        if (!channelPolicy && this.config.default === 'allow') {
          return false;
        }
        return true;
      })
      .map((m) => ({ label: m.label, start: m.start, end: m.end, matched: m.matched }));
  }

  /**
   * Replace the given detected items in content with labelled tokens.
   *
   * Items must come from detect() on this same content (offsets are positions in it); pass a
   * subset to redact only some. Logs and, unless options.audit is false, publishes the
   * outbound.pii_redacted audit event. Pass audit: false to build a redacted copy that is not
   * what goes on the wire (e.g. for the content filter), so the audit trail stays truthful.
   *
   * @param content    The outbound message content the items were detected in.
   * @param items      The items to redact. Empty → content returned unchanged, nothing logged.
   * @param channelId  The destination channel.
   * @param context    Optional metadata for the audit bus event.
   * @param options    audit (default true): false skips the log line and the bus event.
   */
  apply(
    content: string,
    items: readonly DetectedPii[],
    channelId: string,
    context: RedactContext = {},
    options: { audit?: boolean } = {},
  ): RedactionResult {
    if (items.length === 0) {
      return { content, redactions: [] };
    }

    // Step 5: Apply replacements end-to-start so earlier indices remain valid
    // as the string length changes with each substitution. Sort a copy by start so a
    // caller-built subset still works and redactions come back in original order.
    const ordered = [...items].sort((a, b) => a.start - b.start);
    let redacted = content;
    const redactions: RedactionEntry[] = [];

    for (let i = ordered.length - 1; i >= 0; i--) {
      const match = ordered[i]!;
      const replacedWith = `[REDACTED: ${match.label.toUpperCase()}]`;
      redacted = redacted.slice(0, match.start) + replacedWith + redacted.slice(match.end);
      // Build entry without the original matched value — intentional PII-safety design.
      redactions.unshift({
        patternLabel: match.label.toLowerCase(),
        channelId,
        replacedWith,
      });
    }

    if (options.audit === false) {
      return { content: redacted, redactions };
    }

    // Step 6: Log the redaction event.
    this.logger.info(
      {
        event: 'pii_redacted',
        channelId,
        redactionCount: redactions.length,
        patternLabels: redactions.map((r) => r.patternLabel),
        conversationId: context.conversationId,
      },
      'PII redacted from outbound message',
    );

    // Step 7: Publish audit bus event — fire-and-forget. We do not await
    // because a bus failure must not block delivery of the redacted message.
    // Errors are caught and logged at warn level (not error) since the message
    // was already cleaned — audit lag is bad but not a delivery failure.
    this.bus.publish('dispatch', createOutboundPiiRedacted({
      channelId,
      recipientId: context.recipientId ?? '',
      conversationId: context.conversationId ?? '',
      redactions: redactions.map((r) => ({
        patternLabel: r.patternLabel,
        replacedWith: r.replacedWith,
      })),
      parentEventId: context.parentEventId,
    })).catch((err: unknown) => {
      this.logger.warn(
        { err, event: 'pii_redacted_bus_publish_failed', channelId },
        'Failed to publish outbound.pii_redacted audit event',
      );
    });

    return { content: redacted, redactions };
  }

  /**
   * Redact PII from outbound content based on channel policy: apply(content, detect(...)).
   *
   * Returns the (possibly modified) content and a list of applied redactions; the original
   * content unchanged when detect() finds nothing to redact.
   */
  async redact(
    content: string,
    channelId: string,
    context: RedactContext = {},
  ): Promise<RedactionResult> {
    return this.apply(content, this.detect(content, channelId, context), channelId, context);
  }
}
