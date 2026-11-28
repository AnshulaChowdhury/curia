import { afterEach, describe, it, expect } from 'vitest';
import {
  SECRET_REMOVED as X, forgetKnownSecrets, redactSecrets, redactSecretsDeep, rememberEnvironmentSecrets,
  rememberSecret, rememberVaultSecret,
} from '../../../src/security/redact-secrets.js';

// Every value here is made up. Prefixes are joined at run time so no scanner reads this file as a leak.
const join = (...parts: string[]) => parts.join('');

afterEach(() => forgetKnownSecrets());

describe('redactSecrets: known formats', () => {
  it.each([
    ['Anthropic', join('sk-', 'ant-api03-', 'A1b2'.repeat(8))],
    ['OpenAI project', join('sk-', 'proj-', 'A1b2'.repeat(8))],
    ['OpenAI', join('sk-', 'A1b2'.repeat(8))],
    ['AWS key id', join('AKIA', 'ABCDEFGHIJKLMNOP')],
    ['JWT', join('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiIxIn0', '.', 'c2lnbmF0dXJlMTIz')],
    ['GitHub', join('ghp', '_', 'a1B2'.repeat(9))],
    ['Slack', join('xox', 'b-1234567890-abcdefghij')],
    ['Google', join('AIza', 'a1B2c3D4e5'.repeat(4).slice(0, 35))],
    ['Stripe', join('sk', '_live_', 'a1B2'.repeat(6))],
    ['Plaid', join('access-', 'production-', '01234567-89ab-cdef-0123-456789abcdef')],
  ])('removes a %s secret', (_name, secret) => {
    expect(redactSecrets(`here it is ${secret} thanks`)).toBe(`here it is ${X} thanks`);
  });

  it('removes a private key block, even a truncated one', () => {
    const begin = join('-----BEGIN ', 'RSA PRIVATE KEY-----');
    expect(redactSecrets(`a ${begin}\nabc\n${join('-----END ', 'RSA PRIVATE KEY-----')} b`)).toBe(`a ${X} b`);
    expect(redactSecrets(`a ${begin}\nabc`)).toBe(`a ${X}`);
  });

  it('keeps what a value was and removes the value', () => {
    expect(redactSecrets('postgres://curia:hunter2pass@db:5432/curia')).toBe(`postgres://curia:${X}@db:5432/curia`);
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(`Authorization: Basic ${X}`);
    expect(redactSecrets('https://x.test/cb?access_token=abcdef123456&n=1')).toBe(`https://x.test/cb?access_token=${X}&n=1`);
    expect(redactSecrets('{"password":"correct horse","name":"a"}')).toBe(`{"password":"${X}","name":"a"}`);
    expect(redactSecrets('export DEPLOY_TOKEN=abc123def456')).toBe(`export DEPLOY_TOKEN=${X}`);
  });
});

describe('redactSecrets: labelled values', () => {
  it.each([
    ['my password is Tr0ub4dor&3', `my password is ${X}`],
    ['my password is sunshine', `my password is ${X}`],
    ['Password: sunshine', `Password: ${X}`],
    ['password=hunter22, then log in', `password=${X}, then log in`],
    ['the pwd is "open sesame9"', `the pwd is "${X}"`],
    ['API key: abc123def456ghi', `API key: ${X}`],
    ['client secret = s3cr3t-value-9.', `client secret = ${X}.`],
    ['token: Zm9vYmFyMTIzNDU2', `token: ${X}`],
    ['my PIN is 4821', `my PIN is ${X}`],
    ['passcode: Ab12cd34', `passcode: ${X}`],
  ])('%s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    'The password is required.',
    'the password is incorrect',
    'My password is saved in the vault',
    'Password: see the vault entry',
    'Reset your password: https://example.test/reset',
    'max_tokens: 4096 and token count: 12000',
    'resume_token: abc123def456',
    'nextPageToken: CAESBnBhZ2UtMg',
    'The secret to a good budget is consistency',
    'API_KEY=${{ secret(48) }}',
    'Meeting passcode: 482913',
    'Your verification code is 482913',
    'Pin it to the board: item 3',
    'commit 062b3c5cd0a1b2c3d4e5f60718293a4b5c6d7e8f',
    'risk-assessment-of-the-quarterly-budget-plan',
  ])('leaves "%s" alone', (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it('gives the same answer when run twice', () => {
    const once = redactSecrets('Password: sunshine and DEPLOY_TOKEN=abc123def456\n"api_key": "abcd1234efgh"');
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('exact values', () => {
  it('removes a remembered value wherever it appears', () => {
    rememberSecret('plain words nobody would guess');
    expect(redactSecrets('x plain words nobody would guess y')).toBe(`x ${X} y`);
  });

  it('ignores values too short to remove safely', () => {
    rememberSecret('1234');
    expect(redactSecrets('1234 apples')).toBe('1234 apples');
  });

  it('takes secret vault entries and the owner’s own, not settings', () => {
    rememberVaultSecret('tavily_api_key', 'tvly-example-value', 'string');
    rememberVaultSecret('user.bank_login', 'open-sesame-please', 'string');
    rememberVaultSecret('nylas_self_email', 'someone@example.test', 'string');
    rememberVaultSecret('google_oauth', JSON.stringify({ refresh_token: 'refresh-example-0001', email: 'someone@example.test' }), 'json');
    expect(redactSecrets('tvly-example-value open-sesame-please someone@example.test refresh-example-0001'))
      .toBe(`${X} ${X} someone@example.test ${X}`);
  });

  it('takes secrets and the database password from the environment', () => {
    rememberEnvironmentSecrets({ SOME_API_TOKEN: 'env-token-value-1', DATABASE_URL: 'postgres://u:dbpass-value-2@h/d', HOME: '/home/someone' });
    expect(redactSecrets('env-token-value-1 dbpass-value-2 /home/someone')).toBe(`${X} ${X} /home/someone`);
  });
});

describe('redactSecretsDeep', () => {
  it('removes secret-named fields and secrets inside strings, without touching the input', () => {
    const input = { a: ['my password is sunshine'], login: { password: 'anything', apiKey: 'abcd', count: 3 }, token: 'abcd1234' };
    const output = redactSecretsDeep(input);
    expect(output).toEqual({ a: [`my password is ${X}`], login: { password: X, apiKey: X, count: 3 }, token: X });
    expect(input.login.password).toBe('anything');
  });

  it('returns the same object when there is nothing to remove', () => {
    const input = { a: [{ b: 'hello', at: new Date(0) }], promptHash: 'a'.repeat(64) };
    expect(redactSecretsDeep(input)).toBe(input);
  });
});
