// accounts.ts — turns vault secrets into the three phone-inbox mailboxes.
//
// Secrets (all optional; a mailbox without a grant is still listed, empty):
//   nylas_api_key                          shared Nylas key
//   nylas_region                           'us' (default) or 'eu', where the Nylas application lives
//   phone_inbox_grant_<account>            Nylas grant id per mailbox
//   phone_inbox_address_<account>          mailbox address, shown on the phone
// <account> is personal | moonray | work_outlook.

import type { SecretsService } from '../secrets/secrets-service.js';
import { NylasMailbox, NYLAS_REGIONS, type NylasRegion } from './nylas-mailbox.js';
import { PHONE_INBOX_ACCOUNT_IDS, type PhoneInboxAccountConfig } from './phone-inbox-service.js';

export async function loadPhoneInboxAccounts(
  secrets: Pick<SecretsService, 'get'>,
  fetchImpl: typeof fetch = fetch,
): Promise<PhoneInboxAccountConfig[]> {
  const apiKey = (await secrets.get('nylas_api_key'))?.trim();
  const regionSetting = (await secrets.get('nylas_region'))?.trim().toLowerCase() || 'us';
  if (!(regionSetting in NYLAS_REGIONS)) {
    throw new Error(`nylas_region must be 'us' or 'eu', got '${regionSetting}'`);
  }
  const region = regionSetting as NylasRegion; // checked against NYLAS_REGIONS above
  return Promise.all(
    PHONE_INBOX_ACCOUNT_IDS.map(async (id) => {
      const suffix = id.replace('-', '_');
      const grant = (await secrets.get(`phone_inbox_grant_${suffix}`))?.trim();
      const address = (await secrets.get(`phone_inbox_address_${suffix}`))?.trim() || null;
      const reader = apiKey && grant ? new NylasMailbox(apiKey, grant, fetchImpl, region) : null;
      return { id, address, reader };
    }),
  );
}
