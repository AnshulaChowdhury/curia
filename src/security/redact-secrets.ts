// redact-secrets.ts — take passwords, keys and tokens out of anything Curia keeps or shows (ADR-070).
//
// Two ways of recognising a secret:
//   1. its shape: a known key or token format, or a value that follows a label such as "password:";
//   2. its exact value: anything the secrets vault or the environment holds is remembered here.
//
// A password typed with nothing around it to say what it is cannot be recognised. The one-time capture link
// (secret-capture-request) is the way to hand Curia a secret.
//
// Deliberately not matched: bare long hex strings. Event payloads carry content hashes, and the older shape list in
// secret-patterns.ts (which does match them) stays where it was already used.

import { UUID_PATTERN } from '../util/uuid.js';

export const SECRET_REMOVED = '[secret removed]';

/** Shortest exact value worth remembering: shorter ones would blank ordinary words and numbers. */
const MIN_KNOWN_LENGTH = 8;

/** Whole-match formats: the match is the secret. */
const FORMATS: readonly RegExp[] = [
  // Private key blocks. An unterminated one is removed to the end of the text.
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])sk-(?:proj|svcacct|or-v1)-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/g,
  /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g,
  // JSON Web Tokens.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g,
  // GitHub, Slack, Google, Stripe, Plaid, npm, SendGrid, Twilio.
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}/g,
  /(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])xapp-[0-9]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/g,
  /(?<![A-Za-z0-9])GOCSPX-[0-9A-Za-z_-]{20,}/g,
  /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])whsec_[A-Za-z0-9]{16,}/g,
  new RegExp(`(?<![A-Za-z0-9])(?:access|public|link)-(?:sandbox|development|production)-${UUID_PATTERN}`, 'g'),
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g,
  /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])SK[0-9a-f]{32}(?![A-Za-z0-9])/g,
];

/** Formats where group 1 stays (it says what the value was) and group 2 is the secret. */
const PREFIXED: readonly RegExp[] = [
  /(\bauthorization["']?\s*[:=]\s*["']?(?:basic|bearer|token)\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
  /(\bBearer\s+)((?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{24,})/g,
  // user:password@host
  /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@"']{1,100}:)((?!\$)[^\s/@"']{1,200})(?=@)/gi,
  /([?&#](?:access_token|refresh_token|api_key|apikey|client_secret|password)=)([^&\s#"'<>]{6,})/gi,
  // "password": "…" inside JSON text.
  /("(?:password|passwd|secret|client_?secret|access_?token|refresh_?token|api_?key|private_?key|authorization)"\s*:\s*")((?:\\.|[^"\\\n]){4,})(?=")/gi,
  // ENV_STYLE_TOKEN=value
  /(\b[A-Z0-9_]{0,60}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z0-9_]{0,60}=["']?)((?![$<{[])[^\s"']{8,})/g,
];

const PASSWORD_LABEL = 'password|passwd|pass[ _-]?phrase|pwd';
// A passcode of digits alone is usually a meeting number or a one-time sign-in code, which has to get through. It is
// removed only when it is shaped like a password.
const KEY_LABEL = 'passcode|api[ _-]?key|client[ _-]?secret|secret[ _-]?(?:access[ _-]?)?key|(?:access|refresh|auth|api|bot)[ _-]?token';
const SEPARATOR = '[ \\t]*(?:=>|[:=])[ \\t]*|[ \\t]+(?:is|was)(?:[ \\t]*:)?[ \\t]+';
const VALUE = '"[^"\\n]{1,200}"|\'[^\'\\n]{1,200}\'|`[^`\\n]{1,200}`|[^\\s"\'`]{1,200}';

/**
 * "password: …", "my API key is …". Bare "token" and "secret" are not matched after "_" or "-", so names such as
 * resume_token and page-token keep their values.
 */
const LABELLED = new RegExp(
  `((?<![A-Za-z])(?:${PASSWORD_LABEL}|${KEY_LABEL})|(?<![A-Za-z_-])(?:secret|token))(?![A-Za-z])(${SEPARATOR})(${VALUE})`,
  'gi',
);
/** A PIN is only digits, so it needs its own rule. */
const PIN = /((?<![A-Za-z_-])pin(?:[ _-]?(?:code|number))?(?![A-Za-z])(?:[ \t]*[:=][ \t]*|[ \t]+is[ \t]+))(\d{4,8})(?!\d)/gi;

/** Words that follow "password:" or "password is" without being one. */
const NOT_A_VALUE = new Set((
  'required optional none n/a tbd hidden redacted unchanged reset expired incorrect correct missing empty null ' +
  'undefined string boolean number true false yes no saved stored there here safe secure weak strong wrong changed ' +
  'different same ready done fine okay below above attached sent gone valid invalid blank working broken compromised ' +
  'leaked temporary permanent needed protected encrypted updated removed visible shared unknown'
).split(' '));

const IS_PASSWORD_LABEL = new RegExp(`^(?:${PASSWORD_LABEL})$`, 'i');

/** Whether what follows a label looks like a secret rather than the rest of a sentence. */
function looksSecret(label: string, separator: string, raw: string, endsLine: boolean): boolean {
  const quoted = /^["'`]/.test(raw);
  const value = quoted ? raw.slice(1, -1) : raw.replace(/[.,;:!?)\]}>]+$/, '');
  // References, placeholders and links name a secret without being one.
  if (/^(?:[$<{[(*]|https?:\/\/|vault:)/i.test(value) || NOT_A_VALUE.has(value.toLowerCase())) return false;
  const password = IS_PASSWORD_LABEL.test(label);
  if (value.length >= 6 && /\d/.test(value) && /[A-Za-z]/.test(value)) return true;
  if (value.length >= 6 && /[!@#$%^&*+=~|]/.test(value)) return true;
  if (!password) return false;
  if (quoted) return value.length >= 4 && !/\s/.test(value);
  // A plain word counts when nothing follows it: "Password: sunshine", not "Password: see the vault".
  if (!endsLine) return false;
  return /is|was/i.test(separator) ? value.length >= 6 : value.length >= 4;
}

function redactLabelled(text: string): string {
  return text.replace(LABELLED, (match: string, label: string, separator: string, raw: string, offset: number) => {
    const rest = text.slice(offset + match.length);
    const endsLine = /^[ \t.,;!)]*(?:\r?\n|$)/.test(rest);
    if (!looksSecret(label, separator, raw, endsLine)) return match;
    const quote = /^["'`]/.test(raw) ? raw[0]! : '';
    const trailing = quote ? '' : /[.,;:!?)\]}>]*$/.exec(raw)![0];
    return `${label}${separator}${quote}${SECRET_REMOVED}${quote}${trailing}`;
  });
}

// ── Exact values ─────────────────────────────────────────────────────

const known = new Set<string>();
/** Longest first, so a value that contains another is removed whole. Rebuilt after a new value arrives. */
let ordered: string[] | null = null;

/** Remember an exact value to be removed wherever it appears. */
export function rememberSecret(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_KNOWN_LENGTH || known.has(trimmed)) return;
  known.add(trimmed);
  ordered = null;
}

/** Test seam. */
export function forgetKnownSecrets(): void {
  known.clear();
  ordered = null;
}

const SECRET_NAME = /key|token|secret|password|passwd|credential|private|cookie|database_url/i;
const SECRET_LEAF = /(?:token|secret|password|private_?key|api_?key|^value)$/i;

/**
 * Remember a vault entry, if its name says it is a secret. The vault also holds settings (a phone number, an email
 * address) that must stay readable, so only secret-named entries and the owner's own `user.*` entries count.
 */
export function rememberVaultSecret(name: string, value: string, format: 'string' | 'json'): void {
  if (format === 'string') {
    if (name.startsWith('user.') || SECRET_NAME.test(name)) rememberSecret(value);
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return; }
  const walk = (node: unknown, key: string): void => {
    if (typeof node === 'string') {
      if (SECRET_LEAF.test(key) && node.length >= 12) rememberSecret(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
    } else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(parsed, '');
}

const ENV_SECRET_NAME = /(?:_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD|_KEY_ID)$/;

/** Remember the secrets the process was started with, including the database password. */
export function rememberEnvironmentSecrets(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (ENV_SECRET_NAME.test(name)) rememberSecret(value);
    const credentials = /^[a-z][a-z0-9+.-]*:\/\/[^/:@\s]*:([^/@\s]+)@/i.exec(value);
    if (credentials) rememberSecret(credentials[1]!);
  }
}

// ── Redaction ────────────────────────────────────────────────────────

/**
 * Remove the exact values Curia holds. Callers that also run the older shape list run this first, so a pattern cannot
 * cut a known value in half and leave the rest.
 */
export function redactKnownSecrets(text: string): string {
  if (known.size === 0) return text;
  ordered ??= [...known].sort((a, b) => b.length - a.length);
  // Literal replacement: a secret may contain characters that mean something in a pattern.
  let result = text;
  for (const value of ordered) if (result.includes(value)) result = result.split(value).join(SECRET_REMOVED);
  return result;
}

export function redactSecrets(text: string): string {
  let result = redactKnownSecrets(text);
  for (const pattern of FORMATS) result = result.replace(pattern, SECRET_REMOVED);
  for (const pattern of PREFIXED) {
    result = result.replace(pattern, (match: string, prefix: string, value: string) =>
      value.startsWith(SECRET_REMOVED.slice(0, 7)) ? match : `${prefix}${SECRET_REMOVED}`);
  }
  result = redactLabelled(result);
  return result.replace(PIN, `$1${SECRET_REMOVED}`);
}

/** Field names whose whole value is a secret, in any spelling of snake or camel case. */
const SECRET_FIELD = /^(?:password|passwd|client_?secret|access_?token|refresh_?token|api_?key|private_?key|authorization)$/i;
/** Also secret in a record that is only read back by people, never acted on. */
const SECRET_FIELD_IN_RECORDS = /^(?:secret|token)$/i;

export function isSecretField(name: string, inRecord: boolean): boolean {
  return SECRET_FIELD.test(name) || (inRecord && SECRET_FIELD_IN_RECORDS.test(name));
}

/**
 * Redact every string inside a JSON-like value, and every secret-named field. Returns the same object when nothing
 * changed, so callers can tell, and leaves the input untouched. Anything that is not a plain object or array is
 * returned as it is.
 */
export function redactSecretsDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const cleaned = redactSecrets(node);
      return cleaned === node ? node : cleaned;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) return node;
    const plain = Array.isArray(node) || Object.getPrototypeOf(node) === Object.prototype || Object.getPrototypeOf(node) === null;
    if (!plain) return node;
    seen.add(node);
    let changed = false;
    let copy: unknown;
    if (Array.isArray(node)) {
      copy = node.map((item) => {
        const next = walk(item);
        changed ||= next !== item;
        return next;
      });
    } else {
      copy = Object.fromEntries(Object.entries(node).map(([key, item]) => {
        const next = typeof item === 'string' && item.length >= 4 && item !== SECRET_REMOVED && isSecretField(key, true)
          ? SECRET_REMOVED
          : walk(item);
        changed ||= next !== item;
        return [key, next];
      }));
    }
    seen.delete(node);
    return changed ? copy : node;
  };
  return walk(value) as T;
}
