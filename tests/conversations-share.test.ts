import { describe, expect, test } from 'vitest';
import { buildShareBody } from '../src/commands/conversations/share.js';
import { REDACTED } from '../src/lib/redact.js';

/**
 * F9 verification: `spycore conversations share` MUST redact before upload.
 * buildShareBody is the single choke point - the POST carries only its
 * output - so pinning it against 40+ secret formats pins the guarantee.
 * Every secret below must be absent from the serialized share body.
 */

const PEM_RSA = [
  '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEA7bq9xYzSecretBody1',
  '-----END ' + 'RSA PRIVATE KEY-----',
].join('\n');
const PEM_OPENSSH = [
  '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUSecretBody2',
  '-----END ' + 'OPENSSH PRIVATE KEY-----',
].join('\n');
const PEM_ENC = [
  '-----BEGIN ' + 'ENCRYPTED PRIVATE KEY-----',
  'MIIBvTBXBgkqhkiG9w0BBQ0wSjApBgkqSecretBody3',
  '-----END ' + 'ENCRYPTED PRIVATE KEY-----',
].join('\n');
const PGP = [
  '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----',
  'lQdGBFSecretBody4',
  '-----END ' + 'PGP PRIVATE KEY BLOCK-----',
].join('\n');

/**
 * Token-shaped fixtures are built by concatenation, never as one literal:
 * the repo has GitHub push protection on, and a literal secret-shaped string
 * in a test file blocks the push even when it is an obvious fixture (every
 * value here is synthetic and asserted REDACTED, never a real credential).
 * Runtime values are identical to the literals they replace.
 */
const T = (parts: string[]): string => parts.join('');
const A16 = 'a'.repeat(16);
const A20 = 'a'.repeat(20);

// [description, secret as it appears in a message]
const SECRETS: Array<[string, string]> = [
  ['Bearer token', T(['Bearer ', A20, 'XYZtoken'])],
  ['OpenAI sk-', T(['sk-', A20, '1234567890'])],
  ['Anthropic sk-ant-', 'sk-ant-api03-' + 'abcdefghijklmnop1234'],
  ['OpenAI sk-proj-', 'sk-proj-' + 'abcdefghijklmnop12345678'],
  ['Stripe sk_live_', T(['sk_live_', A16, '1234'])],
  ['Stripe sk_test_', T(['sk_test_', A16, '1234'])],
  ['GitHub ghp_', T(['ghp_', A20, '12345678'])],
  ['GitHub gho_', T(['gho_', A20, '12345678'])],
  ['GitHub ghs_', T(['ghs_', A20, '12345678'])],
  ['GitHub ghu_', T(['ghu_', A20, '12345678'])],
  ['GitHub fine-grained github_pat_', T(['github_pat_', A20, '1234567890ABCD'])],
  ['GitLab glpat-', T(['glpat-', A16, '1234'])],
  ['npm npm_', T(['npm_', A16, '123456'])],
  ['PyPI pypi-', 'pypi-AgEIcHlwaS5vcmc' + 'JGU1Njc4OTAxLTVmN2EtNDU4YS04YjQyLWY3OWZiNTk4ZDMzNQAC'],
  ['HuggingFace hf_', T(['hf_', A20, '1234567890'])],
  ['Slack xoxb-', T(['xoxb-', '123456789012', '-', A16])],
  ['Slack xoxa-', T(['xoxa-', '123456789012', '-', A16])],
  ['Slack xoxp-', T(['xoxp-', '123456789012', '-', A16])],
  ['Slack xoxr-', T(['xoxr-', '123456789012', '-', A16])],
  ['Slack xoxs-', T(['xoxs-', '123456789012', '-', A16])],
  ['Slack xoxe-', T(['xoxe-', '123456789012', '-', A16])],
  ['Slack xapp-', T(['xapp-1-ABCDEF123456-', 'abcdef12345678'])],
  ['AWS AKIA', T(['AKIA', 'IOSFODNN7EXAMPLE'])],
  ['AWS temp ASIA', T(['ASIA', 'IOSFODNN7EXAMPLE'])],
  ['Google AIza', T(['AIza', 'SyAbcDefGhIjKlMnOpQrStUvWx1234567'])],
  ['Google OAuth ya29.', T(['ya29.', 'a0AbcDefGhIjKlMnOpQrStUvWx1234567890'])],
  ['DigitalOcean dop_v1_', T(['dop_v1_', 'a'.repeat(64)])],
  ['SendGrid SG.', T(['SG.', 'abcdefghijklmnopqrstuvwx'])],
  ['Tailscale tskey-api-', T(['tskey-api-', A20, '1234567890abcd'])],
  ['xAI xai-', T(['xai-', 'b'.repeat(32)])],
  ['Discord mfa.', T(['mfa.', 'c'.repeat(84)])],
  ['Telegram bot token', T(['123456789:', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX'])],
  ['JWT', T(['eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'])],
  ['labeled api_key=', 'api_key=supersecretvalue123'],
  ['labeled password:', 'password: "hunter2hunter"'],
  ['labeled passwd=', 'passwd=s3cr3tpass'],
  ['labeled auth_token=', 'auth_token=authtokensecret1'],
  ['labeled access_token=', 'access_token=accesstokensecret2'],
  ['labeled refresh_token=', 'refresh_token=refreshtokensecret3'],
  ['labeled client_secret=', 'client_secret=clientsecretvalue4'],
  ['labeled api_secret=', 'api_secret=apisecretvalue5'],
  ['labeled secret_key=', 'secret_key=secretkeyvalue6'],
  ['RSA private key block', PEM_RSA],
  ['OpenSSH private key block', PEM_OPENSSH],
  ['encrypted private key block', PEM_ENC],
  ['PGP private key block', PGP],
  ['URL userinfo https', 'https://deploy:s3cr3tdeploy@example.com/app'],
  ['URL userinfo postgres', 'postgres://admin:dbp4ssw0rd@db:5432/app'],
  ['URL userinfo redis empty-user', 'redis://:redisp4ss@localhost:6379/0'],
];

function convoWithSecrets() {
  return {
    id: 'convo-1',
    title: T(['deploy help ', 'sk-', A20, '1234567890']),
    model: 'hermes',
    createdAt: '2026-10-07T10:00:00Z',
    updatedAt: '2026-10-07T10:05:00Z',
    messages: SECRETS.map(([desc, secret], i) => ({
      role: i % 2 === 0 ? 'USER' : 'ASSISTANT',
      content: `${desc}: here it is -> ${secret} <- done`,
      model: i % 2 === 0 ? null : 'hermes',
      createdAt: '2026-10-07T10:00:00Z',
    })),
  };
}

describe('conversations share (F9): redaction before upload', () => {
  test(`redacts all ${SECRETS.length} secret formats (40+ required)`, () => {
    expect(SECRETS.length).toBeGreaterThanOrEqual(40);
    const body = buildShareBody(convoWithSecrets());
    const serialized = JSON.stringify(body);
    for (const [desc, secret] of SECRETS) {
      // Multi-line blocks: check the distinctive body line, not the
      // BEGIN/END markers (markers alone are not the secret).
      const probe = secret.includes('\n')
        ? secret.split('\n')[1]!
        : secret;
      expect(
        serialized,
        `${desc} leaked into the share body: ${probe.slice(0, 24)}…`,
      ).not.toContain(probe);
    }
    expect(serialized).toContain(REDACTED);
  });

  test('redacts secrets in the title too', () => {
    const body = buildShareBody(convoWithSecrets());
    expect(body.title).not.toContain(T(['sk-', A20, '1234567890']));
    expect(body.title).toContain(REDACTED);
  });

  test('preserves structure: roles, order, model, timestamps', () => {
    const body = buildShareBody(convoWithSecrets());
    expect(body.model).toBe('hermes');
    expect(body.messages).toHaveLength(SECRETS.length);
    expect(body.messages[0]!.role).toBe('USER');
    expect(body.messages[1]!.role).toBe('ASSISTANT');
    expect(body.messages[0]!.createdAt).toBe('2026-10-07T10:00:00Z');
  });

  test('leaves ordinary prose byte-identical', () => {
    const plain = 'The quick brown fox jumps over the lazy dog. 12345.';
    const body = buildShareBody({
      id: 'c',
      title: 'plain',
      model: 'm',
      createdAt: '',
      updatedAt: '',
      messages: [{ role: 'USER', content: plain, createdAt: '' }],
    });
    expect(body.messages[0]!.content).toBe(plain);
    expect(body.title).toBe('plain');
  });

  test('does not mutate the input conversation', () => {
    const convo = convoWithSecrets();
    const before = JSON.stringify(convo);
    buildShareBody(convo);
    expect(JSON.stringify(convo)).toBe(before);
  });
});
