// start.ts — boots real-time inbox triage from vault secrets. Off unless `inbox_triage_enabled` is "true".
//
// Secrets (all in the vault; none in code or config files):
//   inbox_triage_enabled            "true" to turn the watcher on
//   inbox_triage_ntfy_url           full ntfy topic address the phone is subscribed to, e.g. https://ntfy.example.com/curia-mail
//   inbox_triage_ntfy_token         optional bearer token for a protected topic
//   inbox_triage_min_confidence     0..1, default 0.6 (below it urgent/drafted become an unsure "seen")
//   nylas_api_key, nylas_region     shared with /phone/inbox
//   phone_inbox_grant_<account>     Nylas grant per mailbox (personal | moonray | work_outlook)

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { SecretsService } from '../secrets/secrets-service.js';
import { NYLAS_REGIONS, type NylasRegion } from '../phone-inbox/nylas-mailbox.js';
import { PHONE_INBOX_ACCOUNT_IDS } from '../phone-inbox/phone-inbox-service.js';
import { AgentClassifier, type AgentClassifierConfig } from './agent-classifier.js';
import type { ContactLookup } from './contact-lookup.js';
import { NtfyNotifier } from './ntfy-notifier.js';
import { NylasTriageSource } from './nylas-triage-source.js';
import { startOfLocalDay } from '../phone-brief/local-time.js';
import type { PgTriageStore } from './item-store.js';
import type { UnsubscribeEnforcer } from './unsubscribe-enforcer.js';
import { InboxWatcher, type TriageNotifier } from './watcher.js';

const POLL_INTERVAL_MS = 30_000;
const CLASSIFY_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_CONFIDENCE = 0.6;
/** Triage covers mail received on or after this local date, read or not (the owner's decision, 2026-11-02). */
export const TRIAGE_FROM_DATE = '2026-11-01';

export interface InboxTriageDeps {
  bus: EventBus;
  logger: Logger;
  secrets: Pick<SecretsService, 'get'>;
  /** Remembers classified ids across restarts and keeps the unsorted mail for review from the phone. */
  items: PgTriageStore;
  /** Lets the classifier know when the sender is in the principal's contacts. Optional. */
  contacts?: ContactLookup;
  /** What the owner has said about senders before; given to the classifier as a hint. Optional. */
  preferences?: AgentClassifierConfig['preferences'];
  /** Repeats the unsubscribe request, then trashes, mail from senders the owner unsubscribed from. Optional. */
  unsubscribeEnforcer?: UnsubscribeEnforcer;
  /** IANA timezone that decides where TRIAGE_FROM_DATE starts. */
  timezone: string;
  fetchImpl?: typeof fetch;
}

export interface RunningInboxTriage {
  stop: () => void;
  accounts: string[];
}

/** Vault keys the Settings → API connections form writes. */
export const TRIAGE_SECRET_KEYS = {
  enabled: 'inbox_triage_enabled',
  ntfyUrl: 'inbox_triage_ntfy_url',
  ntfyToken: 'inbox_triage_ntfy_token',
  minConfidence: 'inbox_triage_min_confidence',
} as const;

/** Returns the running watcher, or null when triage is off or not fully configured. */
export async function startInboxTriage(deps: InboxTriageDeps): Promise<RunningInboxTriage | null> {
  const { bus, logger, secrets, items, timezone, contacts, preferences, unsubscribeEnforcer, fetchImpl = fetch } = deps;
  const read = async (key: string): Promise<string | null> => (await secrets.get(key))?.trim() || null;

  if ((await read('inbox_triage_enabled'))?.toLowerCase() !== 'true') {
    logger.info('inbox-triage: off (inbox_triage_enabled is not "true")');
    return null;
  }

  const apiKey = await read('nylas_api_key');
  const regionSetting = (await read('nylas_region'))?.toLowerCase() ?? 'us';
  if (!apiKey || !(regionSetting in NYLAS_REGIONS)) {
    logger.warn('inbox-triage: off (nylas_api_key missing, or nylas_region is not us/eu)');
    return null;
  }
  const region = regionSetting as NylasRegion; // checked against NYLAS_REGIONS above

  const since = Math.floor(startOfLocalDay(TRIAGE_FROM_DATE, timezone) / 1000);
  const sources: NylasTriageSource[] = [];
  for (const id of PHONE_INBOX_ACCOUNT_IDS) {
    const grant = await read(`phone_inbox_grant_${id.replace('-', '_')}`);
    if (grant) sources.push(new NylasTriageSource(id, apiKey, grant, fetchImpl, region, since));
  }
  if (sources.length === 0) {
    logger.warn('inbox-triage: off (no phone_inbox_grant_* secret is set)');
    return null;
  }

  const ntfyUrl = await read('inbox_triage_ntfy_url');
  // Without ntfy the watcher still tags mail (the phone sees it on its next refresh); it just cannot wake the phone.
  const notifier: TriageNotifier = ntfyUrl
    ? new NtfyNotifier(ntfyUrl, await read('inbox_triage_ntfy_token'), fetchImpl)
    : { notify: async () => {} };
  if (!ntfyUrl) logger.warn('inbox-triage: no ntfy address set, so tagged mail will not wake the phone');

  const minConfidenceRaw = Number(await read('inbox_triage_min_confidence'));
  const minConfidence = Number.isFinite(minConfidenceRaw) && minConfidenceRaw > 0 && minConfidenceRaw <= 1
    ? minConfidenceRaw
    : DEFAULT_MIN_CONFIDENCE;

  const watcher = new InboxWatcher({
    sources,
    classifier: new AgentClassifier({ bus, logger, minConfidence, timeoutMs: CLASSIFY_TIMEOUT_MS,
      ...(contacts ? { contacts } : {}), ...(preferences ? { preferences } : {}) }),
    notifier,
    seen: items,
    outcomes: items,
    ...(unsubscribeEnforcer ? { beforeClassify: (c, s) => unsubscribeEnforcer.check(c, s) } : {}),
    logger,
    intervalMs: POLL_INTERVAL_MS,
  });
  watcher.start();
  const accounts = sources.map((s) => s.accountId);
  logger.info({ accounts }, 'inbox-triage: started');
  return { stop: () => watcher.stop(), accounts };
}

/** One mailbox for writing a label from the phone's review cards; null when it has no grant or Nylas is not set up. */
export async function loadTriageSource(
  secrets: Pick<SecretsService, 'get'>,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NylasTriageSource | null> {
  if (!(PHONE_INBOX_ACCOUNT_IDS as readonly string[]).includes(accountId)) return null;
  const apiKey = (await secrets.get('nylas_api_key'))?.trim();
  const regionSetting = (await secrets.get('nylas_region'))?.trim().toLowerCase() || 'us';
  const grant = (await secrets.get(`phone_inbox_grant_${accountId.replace('-', '_')}`))?.trim();
  if (!apiKey || !grant || !(regionSetting in NYLAS_REGIONS)) return null;
  return new NylasTriageSource(accountId, apiKey, grant, fetchImpl, regionSetting as NylasRegion); // region checked above
}
