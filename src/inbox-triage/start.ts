// start.ts — boots real-time inbox triage from vault secrets. Off unless `inbox_triage_enabled` is "true".
//
// Secrets (all in the vault; none in code or config files):
//   inbox_triage_enabled            "true" to turn the watcher on
//   inbox_triage_ntfy_url           ntfy server, e.g. https://ntfy.example.com
//   inbox_triage_ntfy_topic         topic the phone is subscribed to
//   inbox_triage_ntfy_token         optional bearer token for a protected topic
//   inbox_triage_min_confidence     0..1, default 0.6 (below it urgent/drafted become an unsure "seen")
//   nylas_api_key, nylas_region     shared with /phone/inbox
//   phone_inbox_grant_<account>     Nylas grant per mailbox (personal | moonray | work_outlook)

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { SecretsService } from '../secrets/secrets-service.js';
import { NYLAS_REGIONS, type NylasRegion } from '../phone-inbox/nylas-mailbox.js';
import { PHONE_INBOX_ACCOUNT_IDS } from '../phone-inbox/phone-inbox-service.js';
import { AgentClassifier } from './agent-classifier.js';
import { NtfyNotifier } from './ntfy-notifier.js';
import { NylasTriageSource } from './nylas-triage-source.js';
import { PersistedSeenStore, type KeyValueStore } from './seen-store.js';
import { InboxWatcher, type SeenStore, type TriageNotifier } from './watcher.js';

const POLL_INTERVAL_MS = 30_000;
const CLASSIFY_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_CONFIDENCE = 0.6;

export interface InboxTriageDeps {
  bus: EventBus;
  logger: Logger;
  secrets: Pick<SecretsService, 'get'>;
  /** Durable store for classified ids. Without one, ids are remembered only until restart. */
  store: KeyValueStore | undefined;
  fetchImpl?: typeof fetch;
}

/** Returns a stop function, or null when triage is off or not fully configured. */
export async function startInboxTriage(deps: InboxTriageDeps): Promise<(() => void) | null> {
  const { bus, logger, secrets, store, fetchImpl = fetch } = deps;
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

  const sources: NylasTriageSource[] = [];
  for (const id of PHONE_INBOX_ACCOUNT_IDS) {
    const grant = await read(`phone_inbox_grant_${id.replace('-', '_')}`);
    if (grant) sources.push(new NylasTriageSource(id, apiKey, grant, fetchImpl, region));
  }
  if (sources.length === 0) {
    logger.warn('inbox-triage: off (no phone_inbox_grant_* secret is set)');
    return null;
  }

  const ntfyUrl = await read('inbox_triage_ntfy_url');
  const ntfyTopic = await read('inbox_triage_ntfy_topic');
  // Without ntfy the watcher still tags mail (the phone sees it on its next refresh); it just cannot wake the phone.
  const notifier: TriageNotifier = ntfyUrl && ntfyTopic
    ? new NtfyNotifier(ntfyUrl, ntfyTopic, await read('inbox_triage_ntfy_token'), fetchImpl)
    : { notify: async () => {} };
  if (!(ntfyUrl && ntfyTopic)) logger.warn('inbox-triage: no ntfy url/topic set, so tagged mail will not wake the phone');

  const minConfidenceRaw = Number(await read('inbox_triage_min_confidence'));
  const minConfidence = Number.isFinite(minConfidenceRaw) && minConfidenceRaw > 0 && minConfidenceRaw <= 1
    ? minConfidenceRaw
    : DEFAULT_MIN_CONFIDENCE;

  let seen: SeenStore;
  if (store) {
    seen = new PersistedSeenStore(store);
  } else {
    logger.warn('inbox-triage: no config store, so classified ids are forgotten on restart');
    const ids = new Set<string>();
    seen = { has: async (k) => ids.has(k), add: async (k) => { ids.add(k); } };
  }

  const watcher = new InboxWatcher({
    sources,
    classifier: new AgentClassifier({ bus, logger, minConfidence, timeoutMs: CLASSIFY_TIMEOUT_MS }),
    notifier,
    seen,
    logger,
    intervalMs: POLL_INTERVAL_MS,
  });
  watcher.start();
  logger.info({ accounts: sources.map((s) => s.accountId) }, 'inbox-triage: started');
  return () => watcher.stop();
}
