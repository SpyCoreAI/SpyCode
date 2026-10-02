/**
 * ⭐⭐ F-2c-46 — THE CREDENTIAL DISCLOSURE CORPUS (`C-AC18`).
 *
 * WHAT THIS IS FOR. A credential stored in the CLI's config can reach a
 * terminal, a CI log or a pasted issue through any command that DUMPS the
 * config. This corpus asserts, by DRIVING THE SHIPPED COMMANDS and searching
 * their real stdout, that no such value is ever printed — and, in the same
 * invocation, that the NON-secret information a user debugging a broken server
 * needs is still readable.
 *
 * ⭐⭐ WHY IT IS NOT DERIVED FROM THE REDACTOR. `lib/redact.ts` screens by KEY
 * NAME against a fixed pattern. A corpus built from that pattern could only
 * contain names the screen already matches, and would pass by construction —
 * the shape F-2c-45 refused for `SAFE_DEVICE_ROLES`. This corpus is derived
 * instead from WHAT A CONFIG FILE CAN LEGALLY CONTAIN (the persisted
 * interfaces, read out of src/ by the completeness test at the bottom) and from
 * credential-carrying HTTP header names as they occur in the wild. `HEADER_NAMES`
 * therefore straddles the screen deliberately, and a test below proves it does:
 * a corpus that cannot reach past the screen cannot falsify it.
 *
 * ⭐ THE UNBOUNDED KEY SPACE IS THE WHOLE POINT. `McpServerConfig.headers` is
 * `Record<string, string>` whose names are user-supplied over
 * `/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/`. No name-keyed screen can enumerate that
 * space. The property under test is therefore about the VALUE, not the key.
 *
 * ⭐ BOTH DIRECTIONS, ALWAYS TOGETHER. Every hostile assertion has a benign
 * counterpart in the same file, because a redactor that hides the field a user
 * needs is a different defect wearing a safer name.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

// ─────────────────────────── sentinels ───────────────────────────
// Distinct, greppable, and none a substring of another, so a hit is
// attributable to exactly one planting site. ⭐ F-2c-45 §2b: attribute by
// CARRYING the identity through the row, never by re-deriving it from the text.
const SENT = {
  token: 'SENTINELx1xTOKEN',
  providerKey: 'SENTINELx2xPROVIDERKEY',
  providerBaseUrlPw: 'SENTINELx3xPROVIDERBASEPW',
  apiUrlPw: 'SENTINELx4xAPIURLPW',
  mcpUrlPw: 'SENTINELx5xMCPURLPW',
  header: 'SENTINELx6xHEADER',
  envLiteral: 'SENTINELx7xENVLITERAL',
} as const;

/** Non-secret facts a user debugging a broken server must still be able to read. */
const NEEDED = {
  apiHost: 'api.spycore.ai',
  mcpHost: 'mcp.example.com',
  providerHost: 'api.openai.com',
  serverName: 'remoteserver',
  envVarName: 'MY_MCP_ENV_NAME',
  headerEnvVar: 'MY_HEADER_TOKEN_VAR',
  headerName: 'X-Trace-Id',
  headerPlainValue: 'trace-1234-not-a-secret',
} as const;

/**
 * Credential-carrying header names as they occur in the wild (IANA registry
 * plus the common vendor forms). ⭐ Chosen WITHOUT consulting the redactor, and
 * proved below to straddle it.
 */
const HEADER_NAMES = [
  'Authorization',
  'Proxy-Authorization',
  'Cookie',
  'X-Api-Key',
  'Api-Key',
  'X-Goog-Api-Key',
  'X-Functions-Key',
  'Authentication',
  'X-Session-Id',
  'X-Auth-Token',
  'X-Access-Token',
  'Private-Token',
  'X-Shopify-Access-Token',
  'X-Amz-Security-Token',
] as const;

/** The value shapes a header can legally hold. */
const VALUE_SHAPES = [
  { id: 'literal', build: (s: string) => s, carriesSentinel: true },
  { id: 'scheme+literal', build: (s: string) => `Bearer ${s}`, carriesSentinel: true },
  { id: 'basic-b64ish', build: (s: string) => `Basic ${s}`, carriesSentinel: true },
  { id: 'cookie-pair', build: (s: string) => `session=${s}; Path=/`, carriesSentinel: true },
  { id: 'env-ref-only', build: () => `\${${NEEDED.headerEnvVar}}`, carriesSentinel: false },
  { id: 'scheme+env-ref', build: () => `Bearer \${${NEEDED.headerEnvVar}}`, carriesSentinel: false },
] as const;

// ─────────────────────────── sink harness ───────────────────────────

let chunks: string[] = [];
const origWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  freshConfigDir();
  chunks = [];
  process.stdout.write = ((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = origWrite;
  vi.resetModules();
});

type Registrar = (program: unknown) => void;

/**
 * Drive one shipped command for real: the command's own registrar on a fresh
 * commander program, the real output layer, the real conf-backed store. Nothing
 * here re-implements a sink; what is measured is the bytes a sink writes.
 */
async function drive(
  modulePath: string,
  registrarName: string,
  argv: string[],
  parent: string[] = [],
): Promise<string> {
  const before = chunks.length;
  const { Command } = await import('commander');
  const mod = (await import(modulePath)) as Record<string, unknown>;
  const register = mod[registrarName] as Registrar;
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parent.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  register(program);
  await program.parseAsync(['node', 'spycore', ...parent, ...argv]);
  return chunks.slice(before).join('');
}

/** Every shipped invocation that can dump stored config. */
const SINKS = [
  { label: 'config get --json', mod: '../src/commands/config/index.js', reg: 'registerConfigCommand', argv: ['config', 'get'], parent: ['--json'] },
  { label: 'config get (text)', mod: '../src/commands/config/index.js', reg: 'registerConfigCommand', argv: ['config', 'get'], parent: [] },
  { label: 'config list --json', mod: '../src/commands/config/index.js', reg: 'registerConfigCommand', argv: ['config', 'list'], parent: ['--json'] },
  { label: 'config list (text)', mod: '../src/commands/config/index.js', reg: 'registerConfigCommand', argv: ['config', 'list'], parent: [] },
  { label: 'config list --format yaml', mod: '../src/commands/config/index.js', reg: 'registerConfigCommand', argv: ['config', 'list', '--format', 'yaml'], parent: [] },
  { label: 'config list --format markdown', mod: '../src/commands/config/index.js', reg: 'registerConfigCommand', argv: ['config', 'list', '--format', 'markdown'], parent: [] },
  { label: 'mcp list --json', mod: '../src/commands/mcp/index.js', reg: 'registerMcpCommand', argv: ['mcp', 'list'], parent: ['--json'] },
  { label: 'mcp list (text)', mod: '../src/commands/mcp/index.js', reg: 'registerMcpCommand', argv: ['mcp', 'list'], parent: [] },
  { label: 'provider list --json', mod: '../src/commands/provider/index.js', reg: 'registerProviderCommand', argv: ['provider', 'list'], parent: ['--json'] },
  { label: 'provider list (text)', mod: '../src/commands/provider/index.js', reg: 'registerProviderCommand', argv: ['provider', 'list'], parent: [] },
] as const;

/** Seed one store carrying a credential at every site the shapes allow. */
async function seedEverything(headers: Record<string, string>): Promise<void> {
  const cfg = await import('../src/lib/config.js');
  const store = cfg.getConfigStore();
  // A hand-edited config is not re-validated on READ, so userinfo can be present
  // in any stored URL even though `mcp add` / `config set` would refuse it.
  store.set('apiUrl', `https://user:${SENT.apiUrlPw}@${NEEDED.apiHost}/api`);
  cfg.setStoredTokenInFile(SENT.token);
  cfg.setStoredProviders([
    {
      name: 'inlinekey',
      type: 'openai',
      baseURL: `https://user:${SENT.providerBaseUrlPw}@${NEEDED.providerHost}/v1`,
      apiKey: SENT.providerKey,
    },
  ]);
  cfg.setStoredMcpServers([
    {
      name: NEEDED.serverName,
      type: 'http',
      url: `https://user:${SENT.mcpUrlPw}@${NEEDED.mcpHost}/mcp`,
      headers: { ...headers, [NEEDED.headerName]: NEEDED.headerPlainValue },
    },
    {
      name: 'localserver',
      command: 'some-server',
      env: [{ name: NEEDED.envVarName }, { name: 'PASTED', value: SENT.envLiteral }],
    },
  ]);
}

async function collectAllSinks(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of SINKS) {
    out.set(s.label, await drive(s.mod, s.reg, [...s.argv], [...s.parent]));
  }
  return out;
}

// ─────────────────────────── the corpus can reach past the screen ───────────

describe('C-AC18 · the corpus is able to falsify the screen it tests', () => {
  test('HEADER_NAMES straddles isSecretKey — some matched, some not', async () => {
    const { isSecretKey } = await import('../src/lib/redact.js');
    const matched = HEADER_NAMES.filter((h) => isSecretKey(h));
    const unmatched = HEADER_NAMES.filter((h) => !isSecretKey(h));
    // Both sides must be non-empty. All-matched ⇒ the corpus is derived from the
    // screen and passes by construction. All-unmatched ⇒ it cannot show that the
    // screen does anything at all, so a green would be uninformative.
    expect(matched.length).toBeGreaterThan(0);
    expect(unmatched.length).toBeGreaterThan(0);
  });

  test('the corpus plants at least one credential per persisted container', () => {
    // Containers: the token, the provider list, the MCP list, and the top-level
    // scalar URL. A site that plants nothing proves nothing.
    expect(Object.keys(SENT).length).toBeGreaterThanOrEqual(7);
  });
});

// ─────────────────────────── HOSTILE half ───────────────────────────

describe('C-AC18 · no stored credential reaches any config-dumping sink', () => {
  for (const shape of VALUE_SHAPES) {
    if (!shape.carriesSentinel) continue;
    test(`header value shape "${shape.id}" — no sentinel in any sink`, async () => {
      const headers: Record<string, string> = {};
      for (const name of HEADER_NAMES) headers[name] = shape.build(SENT.header);
      await seedEverything(headers);
      const outs = await collectAllSinks();
      const offenders: string[] = [];
      for (const [label, text] of outs) {
        for (const [site, value] of Object.entries(SENT)) {
          if (text.includes(value)) offenders.push(`${label} ⇠ ${site}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  test('a credential embedded in a stored URL never reaches a sink', async () => {
    await seedEverything({ Authorization: `Bearer ${SENT.header}` });
    const outs = await collectAllSinks();
    const offenders: string[] = [];
    for (const [label, text] of outs) {
      for (const site of ['apiUrlPw', 'mcpUrlPw', 'providerBaseUrlPw'] as const) {
        if (text.includes(SENT[site])) offenders.push(`${label} ⇠ ${site}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('a literal MCP env value never reaches a sink', async () => {
    await seedEverything({ Authorization: `Bearer ${SENT.header}` });
    const outs = await collectAllSinks();
    const offenders = [...outs].filter(([, t]) => t.includes(SENT.envLiteral)).map(([l]) => l);
    expect(offenders).toEqual([]);
  });

  test('the BYOK routing line cannot carry a base-URL credential', async () => {
    const { byokRoutingLine } = await import('../src/lib/providers/byok-config.js');
    // `agent` and `skills create` read the provider list but print only this
    // line. Settled by executing it rather than by reading the call site.
    const line = byokRoutingLine('openai', 'some-model', `https://u:${SENT.providerBaseUrlPw}@h/v1`);
    expect(line).not.toContain(SENT.providerBaseUrlPw);
  });
});

// ─────────────────────────── BENIGN half (the over-redaction fence) ─────────

describe('C-AC18 · what a user debugging a broken server needs is still readable', () => {
  test('endpoints, server names and plain headers survive every sink that shows them', async () => {
    await seedEverything({ Authorization: `Bearer \${${NEEDED.headerEnvVar}}` });
    const outs = await collectAllSinks();
    const all = [...outs.values()].join('\n');
    // The HOST of every configured endpoint must remain visible somewhere: the
    // whole purpose of a config dump is to show where the CLI is pointed.
    expect(all).toContain(NEEDED.apiHost);
    expect(all).toContain(NEEDED.mcpHost);
    expect(all).toContain(NEEDED.providerHost);
    expect(all).toContain(NEEDED.serverName);
    // A header's NAME must not be collateral damage — it is how a user
    // identifies the header they are debugging.
    expect(all).toContain(NEEDED.headerName);
  });

  test('a header VALUE is hidden even when it is not a secret — the shipped contract', async () => {
    // ⭐⭐ THIS FENCE CAUGHT MY OWN CORPUS, NOT THE FIX. The first draft asserted
    // that a plainly non-secret header value (`X-Trace-Id: trace-…`) must stay
    // readable. It went RED on the fix — and the expectation was the thing that
    // was wrong. `mcp-config.ts` ships the contract on the field itself:
    // "Values are NEVER echoed in any output", and `describeHeader`'s own
    // doc says "not even literals", because a user may paste a token into any
    // header despite the `${ENV_VAR}` guidance. A screen cannot tell a trace id
    // from a bearer token, and this product already decided which way to fail.
    //
    // ⭐ SO THE SENTENCE WAS TRUE OF ONE SINK AND FALSE OF THE CLI: `mcp list`
    // honoured it, `config get --json` printed the value. The code is raised to
    // the sentence here rather than the sentence softened to the code.
    await seedEverything({ Authorization: `Bearer \${${NEEDED.headerEnvVar}}` });
    const outs = await collectAllSinks();
    const all = [...outs.values()].join('\n');
    expect(all).not.toContain(NEEDED.headerPlainValue);
  });

  test('an MCP env var NAME stays readable', async () => {
    // ⭐ PURELY BENIGN ON PURPOSE. The matching hostile assertion — that the
    // pasted VALUE is gone — lives in the hostile block above. Keeping the two
    // in one test would have made this fence RED before the fix, and a fence
    // that is red before the fix proves nothing about over-redaction after it.
    await seedEverything({ Authorization: `Bearer \${${NEEDED.headerEnvVar}}` });
    const outs = await collectAllSinks();
    const all = [...outs.values()].join('\n');
    expect(all).toContain(NEEDED.envVarName);
    expect(all).toContain('PASTED');
  });

  test('which env var a header reads from stays discoverable', async () => {
    // ⭐ THE MEASURED COST OF THE OBVIOUS FIX. `mcp list` reports only "(from
    // env)" — it never names the variable — so a flat redaction of every header
    // value would leave NO command able to answer "which variable does this
    // header read?". The `${VAR}` reference is not a secret and is preserved.
    await seedEverything({ Authorization: `Bearer \${${NEEDED.headerEnvVar}}` });
    const outs = await collectAllSinks();
    const all = [...outs.values()].join('\n');
    expect(all).toContain(NEEDED.headerEnvVar);
  });

  test('the provider key SOURCE stays readable even though the key does not', async () => {
    const cfg = await import('../src/lib/config.js');
    cfg.setStoredProviders([
      { name: 'byenv', type: 'anthropic', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'MY_PROVIDER_KEY_VAR' },
    ]);
    const text = await drive('../src/commands/provider/index.js', 'registerProviderCommand', ['provider', 'list'], []);
    // ⭐ The purpose-built sink answers it, which is why the config DUMP is free
    // to keep `apiKeyEnv` masked without costing the user anything.
    expect(text).toContain('MY_PROVIDER_KEY_VAR');
  });
});

// ─────────── F4 · the legs a plausible RE-WRAP would otherwise survive ──────
//
// ⭐⭐ ASKED BEFORE FINISHING: which change to this fix would keep every test
// above green while putting the credential back on stdout? Two, and both are
// changes a reasonable person might make for a reasonable reason. Neither the
// behavioural legs nor the mutation table can see them, because both stay
// inside code paths the legs above never drive.

describe('C-AC18 · re-wraps that would otherwise pass every other leg', () => {
  test('--reveal does NOT widen the bulk dump', async () => {
    // ⭐ RE-WRAP 1. `--reveal` is a real flag, deliberately ignored for the bulk
    // dump today ("reveal a secret only by naming it"). Honouring it here —
    // an easy "the user asked for it" change — would restore the disclosure in
    // full, and every other test in this file passes a bulk dump WITHOUT the
    // flag, so not one of them would notice.
    await seedEverything({ Authorization: `Bearer ${SENT.header}` });
    const text = await drive(
      '../src/commands/config/index.js',
      'registerConfigCommand',
      ['config', 'get', '--reveal'],
      ['--json'],
    );
    for (const [site, value] of Object.entries(SENT)) {
      expect(text, `--reveal leaked ${site}`).not.toContain(value);
    }
  });

  test('no config-dumping sink exists outside the set this corpus drives', () => {
    // ⭐⭐ RE-WRAP 2, AND THE ONE THAT MATTERS. `SINKS` above is a hand-written
    // list. A NEW command that dumps the store — `doctor`, `config export`,
    // `support-bundle` — would disclose exactly what this batch just closed and
    // no test here would fail, because no test would drive it. So the set of
    // sinks is DERIVED from src/ and compared against the declared set: a new
    // one reddens this test until somebody adds it to SINKS and proves it.
    //
    // The derivation is deliberately a SUPERSET (file reads a
    // credential-bearing container AND calls an output primitive), because a
    // superset can be wrong only in the direction that costs review time —
    // never in the direction that misses a sink.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(SRC);
    // Prose is not code: a doc comment naming an accessor is not a call.
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const REACH = /\bgetStoredProviders\s*\(|\bgetStoredMcpServers\s*\(|\bpeekStoredValue\s*\(|\.store\b|\bloadMcpServers\s*\(|\bloadProjectMcpServers\s*\(/;
    const PRINT = /\b(?:json|print|writeFormatted|success|info|warn)\s*\(/;
    const found = files
      .filter((f) => {
        const s = strip(readFileSync(f, 'utf8'));
        return REACH.test(s) && PRINT.test(s);
      })
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
      .sort();

    // The reader must not be silently empty — F-2c-34's vacuity class.
    expect(files.length).toBeGreaterThan(100);
    expect(found.length).toBeGreaterThan(0);

    /**
     * Every entry is accounted for, and HOW is stated:
     *   driven  — this corpus drives it and searches its stdout;
     *   settled — it reaches a container but the only thing it PRINTS from it
     *             is a derivative proved credential-free by its own test above.
     */
    const ACCOUNTED_FOR = [
      'commands/agent.ts', //          settled: prints byokRoutingLine only
      'commands/config/index.ts', //   driven: get/list × json/text/yaml/markdown
      'commands/mcp/index.ts', //      driven: mcp list × json/text
      'commands/provider/index.ts', // driven: provider list × json/text
      'commands/skills/create.ts', //  settled: prints byokRoutingLine only
    ];
    // ⭐ `lib/agent/mcp-config.ts` is deliberately ABSENT: it reaches the
    // containers but owns no output primitive, so it cannot be a sink. Its
    // `describeServerTarget` output is covered where it is PRINTED, in
    // commands/mcp/index.ts. The first draft of this list named it anyway —
    // the derivation was right and the hand-written list was wrong, which is
    // the entire reason the list is compared against a derivation.
    expect(found).toEqual(ACCOUNTED_FOR);
  });
});

// ─────────────────────────── monotonicity ───────────────────────────

describe('C-AC18 · the screen only ever tightens', () => {
  test('every value the name-keyed screen hides is still hidden', async () => {
    const { redactSecrets, REDACTED } = await import('../src/lib/redact.js');
    await seedEverything({ 'X-Auth-Token': SENT.header, Authorization: SENT.header });
    const cfg = await import('../src/lib/config.js');
    const raw = cfg.getConfigStore().store as unknown as Record<string, unknown>;
    // Whatever the pre-existing generic pass replaces must not reappear in the
    // shipped dump. Compared as a set of surviving strings, so a widening of the
    // dump in ANY field reddens this, not only in the ones this batch touched.
    const generic = JSON.stringify(redactSecrets(raw));
    const shipped = await drive('../src/commands/config/index.js', 'registerConfigCommand', ['config', 'get'], ['--json']);
    let checked = 0;
    for (const secret of Object.values(SENT)) {
      if (generic.includes(secret)) continue;
      checked += 1;
      expect(shipped).not.toContain(secret);
    }
    // ⭐ A monotonicity check over an empty set is a green that means nothing —
    // F-2c-34's vacuity class. The floor is asserted, not hoped for.
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(generic).toContain(REDACTED);
  });
});

// ─────────────────────────── completeness, derived from source ──────────────

describe('C-AC18 · the corpus is bound to the shapes it claims to cover', () => {
  /** Read the top-level property names of an interface out of the source. */
  function ifaceFields(src: string, name: string): string[] {
    const m = new RegExp(`export interface ${name}\\s*\\{`).exec(src);
    if (!m) return [];
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(start, i);
    const out: string[] = [];
    let d = 0;
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (d === 0) {
        const pm = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(t);
        if (pm?.[1]) out.push(pm[1]);
      }
      d += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    }
    return out;
  }

  /**
   * ⭐ Every persisted field is classified exactly once. A field added to any of
   * these interfaces later is in NEITHER set, so this test reddens without
   * anyone remembering that a corpus exists. The classification is the claim;
   * the hostile tests above are the proof for the CREDENTIAL side.
   */
  const CREDENTIAL_BEARING = new Set([
    'apiUrl', 'providers', 'mcpServers', // containers reaching a credential
    'apiKey', 'apiKeyEnv', 'baseURL', // StoredProviderConfig
    'url', 'headers', 'env', // McpServerConfig
    'value', // McpEnvVar
  ]);
  const NON_CREDENTIAL = new Set([
    'defaultModel', 'defaultStream', 'defaultEffort', 'injectGuide', 'injectChangelog',
    'autoChangelog', 'autoRefreshGuide', 'agentWebTools', 'agentObserveWorkspace', 'theme',
    'outputFormat', 'lastWhoami', 'defaultProvider', 'trustedWorkspaces',
    'approvedProjectHooks', 'approvedProjectCommandRules',
    'name', 'type', 'model', 'command', 'args', 'enabled',
  ]);

  test('every field of every persisted shape is classified', () => {
    const configSrc = readFileSync(join(SRC, 'lib/config.ts'), 'utf8');
    const byokSrc = readFileSync(join(SRC, 'lib/providers/byok-config.ts'), 'utf8');
    const mcpSrc = readFileSync(join(SRC, 'lib/agent/mcp-config.ts'), 'utf8');
    const fields = [
      ...ifaceFields(configSrc, 'CliConfigSchema'),
      ...ifaceFields(byokSrc, 'StoredProviderConfig'),
      ...ifaceFields(mcpSrc, 'McpServerConfig'),
      ...ifaceFields(mcpSrc, 'McpEnvVar'),
    ];
    // The reader itself must not be silently empty — F-2c-34's vacuity class.
    expect(fields.length).toBeGreaterThan(25);
    const unclassified = [...new Set(fields)].filter(
      (f) => !CREDENTIAL_BEARING.has(f) && !NON_CREDENTIAL.has(f),
    );
    expect(unclassified).toEqual([]);
  });

  test('the header key space really is unbounded in the source', () => {
    const mcpSrc = readFileSync(join(SRC, 'lib/agent/mcp-config.ts'), 'utf8');
    // If `headers` ever became a closed union, a name-keyed screen would be
    // sufficient and this corpus's premise would need revisiting.
    expect(mcpSrc).toMatch(/headers\?:\s*Record<string, string>/);
  });
});
