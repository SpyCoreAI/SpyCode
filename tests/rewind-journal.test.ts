/**
 * THE JOURNAL'S REACH - pinned by EXECUTION through the real `runAgent`.
 *
 * WHY THIS FILE EXISTS. Three shipped documents promised `spycore rewind`
 * undoes "everything the last run changed". Counted mechanically at the
 * predecessor commit, one agent run has SEVEN mutation paths and FIVE were
 * outside the journal:
 *
 * write_file            journaled 1   ✓        edit_file        journaled 1   ✓
 * run_command           journaled 0   FILE GONE / CREATED / EDITED
 * every MCP tool        journaled 0   FILE CREATED
 * pre/post-tool hooks   journaled 0   FILE CREATED
 * CODEBASE_CHANGELOG.md journaled 0   FILE MODIFIED
 * CODEBASE_GUIDE.md     journaled 0   FILE MODIFIED
 *
 * EVERY TEST HERE DRIVES `runAgent`, NOT THE OBSERVER. A pin that called
 * `snapshotWorkspace`/`diffWorkspace` directly would prove the observer works
 * and say NOTHING about whether the loop opens the window - which is the half
 * that was actually missing. The control for that is the `write_file` case: it
 * goes through the same path and must journal EXACTLY ONE record, so a window
 * that double-records is red here too.
 *
 * AND THE BOUNDS ARE PINNED AS ASSERTIONS, NOT AS PROSE. "Outside the
 * workspace is not captured" and "a binary change is reported, not journaled"
 * are the sentences the shipped docs now carry; if they stop being true the
 * documents become false again, so they are tests.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// The orchestrator pin at the bottom of this file drives the real `agent`
// command, which speaks HTTP. The loop tests above use a stub Provider and
// never reach undici, so this mock is inert for them.
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
}
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;
vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));
import { freshConfigDir } from './helpers.js';
import { runAgent } from '../src/lib/agent/loop.js';
import {
  applyRewind,
  latestSession,
  planRewind,
  saveSession,
  sha256,
  type CheckpointSession,
  type RecordedChange,
} from '../src/lib/agent/checkpoint.js';
import { writeScope } from '../src/lib/agent/mcp-config.js';
import {
  coerceValue,
  getConfigPath,
  getConfigStore,
  isKnownKey,
  listKnownKeys,
  trustWorkspace,
} from '../src/lib/config.js';
import { registerAgentCommand, resolveObserveWorkspaceEnabled } from '../src/commands/agent.js';
import { Command } from 'commander';
import { loadHookSession, createAgentHooksBridge } from '../src/lib/hooks.js';
import type { Provider, ProviderEvent } from '../src/lib/providers/types.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';

const WRITER_FIXTURE = fileURLToPath(new URL('./fixtures/mcp-writer-server.mjs', import.meta.url));
const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

class StubProvider implements Provider {
  readonly id = 'openai' as const;
  private turn = 0;
  constructor(private readonly replies: string[]) {}
  createConversation(): Promise<string> {
    return Promise.resolve('cnv_stub');
  }
  async *streamChat(): AsyncIterable<ProviderEvent> {
    const reply = this.replies[this.turn++] ?? 'Done.';
    yield { type: 'text', text: reply };
    yield { type: 'usage', input: 1, output: 1 };
    yield { type: 'done' };
  }
}

let cwd: string;

beforeEach(() => {
  freshConfigDir();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-journal-')));
});

afterEach(async () => {
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Drive a real run and return everything it journaled. */
async function run(replies: string[], extra: Record<string, unknown> = {}): Promise<RecordedChange[]> {
  const changes: RecordedChange[] = [];
  await runAgent({
    task: 'journal pin',
    cwd,
    provider: new StubProvider(replies),
    requestApproval: ACCEPT,
    recordChange: (c) => changes.push(c),
    // - the observer is OPT-IN since R-CLI-1, so every test that
    // exercises it must ASK for it. Placed before `...extra` so the
    // opt-out tests below still override it with `observeWorkspace: false`.
    observeWorkspace: true,
    ...extra,
  });
  return changes;
}

/** Rewind exactly what a run journaled, through the real plan/apply pair. */
function rewind(changes: RecordedChange[]): { restored: number; skipped: number } {
  const session: CheckpointSession = {
    id: '1-pin',
    cwd,
    startedAt: new Date(0).toISOString(),
    task: 'journal pin',
    changes: changes.map((c) => ({ ...c, afterSha: sha256(c.after) })),
  };
  return applyRewind(planRewind(session), cwd);
}

describe('the checkpoint journal reaches the opaque mutation paths', () => {
  /**
   * THE CONTROL FOR EVERY OTHER TEST IN THIS FILE. `write_file` reports
   * itself AND runs inside the observation window, so this is simultaneously
   * "the old path still works" and "the window does not double-count". Exactly
   * one record - two would mean `rewind` restores an intermediate state.
   */
  test('CONTROL - write_file journals EXACTLY ONE record and still rewinds', async () => {
    writeFileSync(join(cwd, 'kept.txt'), 'original\n');
    const changes = await run([block('write_file', { path: 'made.txt', content: 'agent\n' }), 'Done.']);

    const forMade = changes.filter((c) => c.path === join(cwd, 'made.txt'));
    expect(forMade, 'one write must produce one record, not two').toHaveLength(1);
    expect(forMade[0]!.op).toBe('create');
    expect(existsSync(join(cwd, 'made.txt'))).toBe(true);

    expect(rewind(changes).restored).toBe(1);
    expect(existsSync(join(cwd, 'made.txt'))).toBe(false);
    expect(readFileSync(join(cwd, 'kept.txt'), 'utf8'), 'an untouched file is untouched').toBe('original\n');
  });

  /**
   * THE CONTROL ABOVE COULD NOT SEE THIS, AND THE MUTATION TABLE SAID SO.
   *
   * Deleting the observer's self-journaled exclusion - the guard that stops one
   * write being recorded twice - turned NOTHING red. The reason is that the
   * window does not open for `write_file` at all unless something opaque is in
   * play, so the plain `write_file` control never exercises the guard. With a
   * hook configured the window DOES open around a file tool, which is the only
   * arrangement in which the guard can fire, and it is a perfectly ordinary
   * user setup.
   *
   * A double record is not cosmetic: `planRewind` walks the journal in reverse,
   * so two records for one create make the second step operate on a file the
   * first already removed - the rewind stops describing what happened.
   */
  test('CONTROL 2 - with a hook configured, write_file STILL journals exactly once', async () => {
    mkdirSync(join(cwd, '.spycore'), { recursive: true });
    writeFileSync(
      join(cwd, '.spycore', 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'post-tool', command: 'true' }] }),
    );
    trustWorkspace(cwd);
    const session = await loadHookSession(cwd, { approveProjectHook: () => Promise.resolve(true) });
    const hooks = createAgentHooksBridge(session);
    expect(hooks.hasAny, 'the window only opens around a file tool when hooks exist').toBe(true);

    const changes = await run([block('write_file', { path: 'made.txt', content: 'agent\n' }), 'Done.'], { hooks });

    const forMade = changes.filter((c) => c.path === join(cwd, 'made.txt'));
    expect(forMade, 'the tool reported it AND the window saw it - it must be recorded once').toHaveLength(1);

    expect(rewind(changes).restored).toBe(1);
    expect(existsSync(join(cwd, 'made.txt'))).toBe(false);
  });

  test('run_command DELETES a file - journaled as a delete, and rewind brings it back', async () => {
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    const changes = await run([block('run_command', { command: 'rm victim.txt' }), 'Done.']);

    expect(existsSync(join(cwd, 'victim.txt')), 'the command really ran').toBe(false);
    const rec = changes.find((c) => c.path === join(cwd, 'victim.txt'));
    expect(rec, 'the deletion must be journaled').toBeDefined();
    expect(rec!.op).toBe('delete');
    expect(rec!.before).toBe('precious\n');

    expect(rewind(changes).restored).toBe(1);
    expect(readFileSync(join(cwd, 'victim.txt'), 'utf8')).toBe('precious\n');
  });

  /**
   * THE COMMAND IS PORTABLE ON PURPOSE, AND THE FIRST VERSION WAS NOT.
   * `sed -i ''` is BSD syntax: GNU sed reads the `''` as the SCRIPT and the
   * edit silently does not happen. This pin's own "the edit really happened"
   * assertion caught that on the Linux legs - a reminder that a test corpus
   * written on darwin is a darwin corpus until something else runs it. The
   * `sed … > tmp && mv` form is POSIX and exercises the same journal path,
   * plus a temp file created AND removed inside one window, which must
   * therefore produce no record at all.
   */
  test('run_command CREATES and EDITS - both journaled, both reversed', async () => {
    writeFileSync(join(cwd, 'target.txt'), 'aaa\n');
    const changes = await run([
      block('run_command', {
        command: 'echo made > made.txt && sed "s/aaa/zzz/" target.txt > target.tmp && mv target.tmp target.txt',
      }),
      'Done.',
    ]);

    expect(readFileSync(join(cwd, 'target.txt'), 'utf8'), 'the edit really happened').toBe('zzz\n');
    const ops = new Map(changes.map((c) => [c.path, c.op]));
    expect(ops.get(join(cwd, 'made.txt'))).toBe('create');
    expect(ops.get(join(cwd, 'target.txt'))).toBe('modify');
    // Created and removed inside one window ⇒ absent from both pictures ⇒ no record.
    expect(ops.has(join(cwd, 'target.tmp')), 'a temp file that did not survive the window').toBe(false);

    rewind(changes);
    expect(existsSync(join(cwd, 'made.txt'))).toBe(false);
    expect(readFileSync(join(cwd, 'target.txt'), 'utf8')).toBe('aaa\n');
  });

  /**
   * THE MCP HALF. Every MCP wrapper is `mutating: true` and the module has no
   * `recordChange` of its own - it never will, because the window is what
   * covers it. A real server, a real spawn, a real write.
   */
  test('an MCP tool that writes a file is journaled and reversed', async () => {
    writeScope('project', cwd, [{ name: 'w', command: process.execPath, args: [WRITER_FIXTURE] }]);
    trustWorkspace(cwd);
    const target = join(cwd, 'mcp-made.txt');
    const changes = await run([
      block('mcp__w__write_probe', { path: target, text: 'from-mcp\n' }),
      'Done.',
    ]);

    expect(existsSync(target), 'the MCP server really wrote the file').toBe(true);
    const rec = changes.find((c) => c.path === target);
    expect(rec, 'the MCP write must be journaled').toBeDefined();
    expect(rec!.op).toBe('create');

    rewind(changes);
    expect(existsSync(target)).toBe(false);
  });

  /**
   * THE HOOK HALF. A hook is a user-configured shell command that mutates as
   * freely as `run_command`. The window wraps the whole bracket, so a post-tool
   * hook's writes land in the same journal.
   */
  test("a post-tool hook's writes are journaled and reversed", async () => {
    mkdirSync(join(cwd, '.spycore'), { recursive: true });
    writeFileSync(
      join(cwd, '.spycore', 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'post-tool', command: 'echo hooked > hook-made.txt' }] }),
    );
    trustWorkspace(cwd);
    const session = await loadHookSession(cwd, { approveProjectHook: () => Promise.resolve(true) });
    const hooks = createAgentHooksBridge(session);
    expect(hooks.hasAny, 'the hook must actually be loaded - otherwise this proves nothing').toBe(true);

    const changes = await run([block('read_file', { path: '.spycore/hooks.json' }), 'Done.'], { hooks });

    const made = join(cwd, 'hook-made.txt');
    expect(existsSync(made), 'the hook really ran').toBe(true);
    const rec = changes.find((c) => c.path === made);
    expect(rec, "the hook's write must be journaled").toBeDefined();

    rewind(changes);
    expect(existsSync(made)).toBe(false);
  });
});

describe('the journal states its own bounds, and they hold', () => {
  /**
   * THE BOUND THE SHIPPED DOCS NOW NAME. Outside the workspace is outside the
   * journal - asserted rather than described, because it is the sentence a user
   * relies on when they read "restores the files a run touched".
   */
  test('a write OUTSIDE the workspace is NOT journaled', async () => {
    const outside = join(dirname(cwd), `f2c27-outside-${process.pid}.txt`);
    try {
      const changes = await run([
        block('run_command', { command: `echo escaped > ${JSON.stringify(outside)}` }),
        'Done.',
      ]);
      expect(existsSync(outside), 'the command really wrote outside - otherwise this is a blind pass').toBe(true);
      expect(changes.some((c) => c.path === outside), 'must not be journaled').toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  /**
   * A BINARY CHANGE IS DETECTED AND DECLINED, NEVER JOURNALED. The journal
   * round-trips content as UTF-8; journaling a binary would mean `rewind`
   * silently corrupting the file, which is worse than declining to restore it.
   */
  test('a binary file change is NOT journaled (it would not round-trip)', async () => {
    // Written through node rather than `printf '\\x00'`: the `\\xNN` escape is a
    // bash/BSD extension and dash's builtin printf does not honour it, so the
    // first version of this pin produced a TEXT file on the Linux legs and its
    // own "and it really is binary" assertion failed. Node writes the bytes
    // unambiguously on every platform this package supports.
    const changes = await run([
      block('run_command', {
        command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('blob.bin', Buffer.from([0,1,2,0]))"`,
      }),
      'Done.',
    ]);
    const blob = join(cwd, 'blob.bin');
    expect(existsSync(blob), 'the command really created it').toBe(true);
    expect(readFileSync(blob).includes(0), 'and it really is binary').toBe(true);
    expect(changes.some((c) => c.path === blob), 'a binary must not enter the journal').toBe(false);
  });

  /**
   * F-19 - THE SAME GUARANTEE, THROUGH THE SOURCE THAT BROKE IT.
   *
   * The leg above pins "a binary is never journaled" through `run_command`
   * ONLY. `write_file` is the other producer, and it did the opposite: for an
   * existing binary it forced `oldText = ''` while keeping `isNew: false`, so
   * the approval header rendered **`✚ write_file logo.png (+2)`** over
   * `@@ -1,0 +1,2 @@` for the destruction of a 4,104-byte file, the journal
   * carried `before: ''`, and `rewind` reported **`Rewound 1 change(s),
   * skipped 0`** while writing a **0-byte** file.
   *
   * *The corpus that exists to keep a sentence true could not falsify it for
   * the one source that breaks it.* That is why this leg exists at all.
   *
   * THE SHAPE IS REFUSAL, matching the sibling `edit_file`, which has always
   * refused the identical input (`builtin-tools.ts:1014`). Journaling the real bytes
   * would instead make the shipped sentence FALSE BY DESIGN - `rewind.ts:138`
   * and `README.md:32-33` promise binaries are "NOT journaled, so not restored"
   * - and would add a restore path nobody has reviewed. Cost measured before
   * choosing: `write_file` writes `newText` as UTF-8, so it could never produce
   * binary content in the first place; the only capability withdrawn is
   * REPLACING AN EXISTING BINARY WITH TEXT, which is exactly the operation that
   * silently destroyed it. Creating a new file is untouched.
   */
  test(' : write_file REFUSES an existing binary - and the shipped sentence is driven, not read', async () => {
    const logo = join(cwd, 'logo.png');
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4096, 0),
    ]);
    writeFileSync(logo, bytes);
    expect(readFileSync(logo).includes(0), 'the fixture really is binary').toBe(true);

    const changes = await run([block('write_file', { path: 'logo.png', content: 'hello\nworld\n' }), 'Done.']);

    // DRIVEN, NOT READ: the file itself is the assertion, byte for byte.
    expect(readFileSync(logo).byteLength, 'the binary must be untouched').toBe(bytes.byteLength);
    expect(readFileSync(logo).equals(bytes), 'byte-identical').toBe(true);
    expect(changes.some((c) => c.path === logo), 'a binary must not enter the journal').toBe(false);

    // AND THE ZERO IS FORCED: the same tool over a TEXT file still journals
    // a restorable `before`, so this leg cannot pass by journaling nothing.
    const notes = join(cwd, 'notes.txt');
    writeFileSync(notes, 'one\ntwo\nthree\n');
    const textChanges = await run([block('write_file', { path: 'notes.txt', content: 'ONE\n' }), 'Done.']);
    const rec = textChanges.find((c) => c.path === notes);
    expect(rec, 'a TEXT write must still be journaled - otherwise the zero above is vacuous').toBeDefined();
    expect(rec?.before).toBe('one\ntwo\nthree\n');
    expect(rewind(textChanges).restored).toBeGreaterThanOrEqual(1);
    expect(readFileSync(notes, 'utf8'), 'and it restores byte-identically').toBe('one\ntwo\nthree\n');

    // THE CLASS, ASSERTED RATHER THAN DESCRIBED: both `applyMutation`
    // callers refuse the same input. `edit_file` always did; `write_file` does
    // now. 2 of 2 - so the class is closed at every site, not at the one filed.
    writeFileSync(logo, bytes);
    const editChanges = await run([
      block('edit_file', { path: 'logo.png', old_str: 'PNG', new_str: 'XXX' }),
      'Done.',
    ]);
    expect(readFileSync(logo).equals(bytes), 'edit_file refuses it too').toBe(true);
    expect(editChanges.some((c) => c.path === logo)).toBe(false);
  });

  /**
   * `.gitignore`d paths are outside the agent's own read tools and therefore
   * outside the observer - deliberately, so there is ONE definition of "the
   * workspace" in the package rather than two. Pinned so the boundary cannot
   * drift without someone noticing.
   */
  test('a gitignored path is NOT journaled - the observer uses the read tools’ enumeration', async () => {
    writeFileSync(join(cwd, '.gitignore'), 'secret-scratch/\n');
    mkdirSync(join(cwd, 'secret-scratch'), { recursive: true });
    const changes = await run([
      block('run_command', { command: 'echo ignored > secret-scratch/note.txt' }),
      'Done.',
    ]);
    const ignored = join(cwd, 'secret-scratch', 'note.txt');
    expect(existsSync(ignored), 'the command really wrote it').toBe(true);
    expect(changes.some((c) => c.path === ignored)).toBe(false);
  });

  /**
   * THE NO-CLOBBER GUARD, AT THE NEW OP. `planRewind`'s sha guard is what
   * makes observation safe: the observer cannot tell the command's writes from
   * a concurrent edit, so the guard is the thing that protects the user's own
   * work. A deletion's guard is "still absent", and this is the case that
   * proves it refuses.
   */
  /**
   * F-2c-41 - `rewind` MUST NOT DELETE A FILE THE RUN DID NOT CREATE.
   *
   * The observer's population is defined by `.gitignore`, and `.gitignore` is a
   * file the observed command may EDIT. When it does, everything that file was
   * hiding appears in the second picture with no counterpart in the first, and
   * `prior === undefined` was read as "the command created this" - so `rewind`
   * DELETED pre-existing user files. Measured end to end through the shipped
   * journal before the fix: an agent asked to stop ignoring the build output
   * destroyed 2 of 5 pre-existing files, whole subtrees included.
   *
   * The trigger is ORDINARY. "Stop ignoring the build output" is a normal
   * request, not a crafted one - which is what made this a data-loss path rather
   * than a curiosity.
   */
  test(' a pre-existing file the command UN-IGNORED is not journaled as a create', async () => {
    writeFileSync(join(cwd, '.gitignore'), 'coverage/\n*.log\n');
    mkdirSync(join(cwd, 'coverage'), { recursive: true });
    writeFileSync(join(cwd, 'coverage', 'lcov.info'), 'MONTHS OF THE USER\'S DATA\n');
    writeFileSync(join(cwd, 'debug.log'), 'THE LOG THE USER WAS READING\n');

    const changes = await run([
      block('run_command', { command: "printf '# tracked now\\n' > .gitignore" }),
      'Done.',
    ]);

    const victims = [join(cwd, 'coverage', 'lcov.info'), join(cwd, 'debug.log')];
    for (const v of victims) {
      expect(
        changes.some((c) => c.path === v && c.op === 'create'),
        `${v} pre-existed - journaling it as a create makes rewind delete it`,
      ).toBe(false);
    }
    const applied = rewind(changes);
    for (const v of victims) {
      expect(existsSync(v), `${v} must survive \`spycore rewind\``).toBe(true);
    }
    // POSITIVE CONTROL, in the same run: the edit the command really made is
    // still journaled and still undone. A fix that simply stopped journaling
    // would pass every assertion above and be useless.
    expect(changes.some((c) => c.path === join(cwd, '.gitignore') && c.op === 'modify')).toBe(true);
    expect(applied.restored, 'the real change is still restored').toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toBe('coverage/\n*.log\n');
  });

  /**
   * THE SAME DEFECT BY THE OTHER ROUTE - a file that was UNREADABLE when the
   * before-picture was taken is equally absent from `entries`, and equally not
   * a creation. `entries` answers "what could be captured"; only a population no
   * user-editable file governs can answer "what was there".
   */
  test(' a pre-existing file that was UNREADABLE at snapshot time is not a create', async () => {
    const locked = join(cwd, 'locked.txt');
    writeFileSync(locked, 'PRE-EXISTING USER DATA\n');
    chmodSync(locked, 0o000);
    const changes = await run([
      block('run_command', { command: 'chmod 644 locked.txt' }),
      'Done.',
    ]);
    expect(changes.some((c) => c.path === locked && c.op === 'create')).toBe(false);
    rewind(changes);
    expect(existsSync(locked), 'the user’s file must survive the rewind').toBe(true);
    expect(readFileSync(locked, 'utf8')).toBe('PRE-EXISTING USER DATA\n');
  });

  /**
   * AND THE MIRROR: a file the command newly ADDED to `.gitignore` is still on
   * disk. Recording it as deleted would have `rewind` write it back over a file
   * that never went away, and would report a deletion that never happened.
   */
  test(' a file the command newly IGNORED is not journaled as a delete', async () => {
    writeFileSync(join(cwd, '.gitignore'), '# nothing ignored yet\n');
    writeFileSync(join(cwd, 'notes.log'), 'still here\n');
    const changes = await run([
      block('run_command', { command: "printf '*.log\\n' > .gitignore" }),
      'Done.',
    ]);
    expect(
      changes.some((c) => c.path === join(cwd, 'notes.log') && c.op === 'delete'),
      'the file is still on disk - it was not deleted',
    ).toBe(false);
    expect(existsSync(join(cwd, 'notes.log'))).toBe(true);
  });

  test('NEGATIVE CONTROL - a deleted file the user has since recreated is NOT clobbered', async () => {
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    const changes = await run([block('run_command', { command: 'rm victim.txt' }), 'Done.']);
    expect(changes.some((c) => c.op === 'delete'), 'the delete was journaled').toBe(true);

    writeFileSync(join(cwd, 'victim.txt'), 'THE USER WROTE THIS\n');
    const applied = rewind(changes);

    expect(applied.restored, 'nothing may be restored over the user').toBe(0);
    expect(applied.skipped).toBe(1);
    expect(readFileSync(join(cwd, 'victim.txt'), 'utf8')).toBe('THE USER WROTE THIS\n');
  });
});

/**
 * THE ORDERING, PINNED AGAINST THE PERSISTED FILE RATHER THAN AGAINST THE
 * SOURCE.
 *
 * The run's own end-of-task writes - `CODEBASE_CHANGELOG.md`, and
 * `CODEBASE_GUIDE.md` on a structural change - are workspace files the run
 * modifies, so `rewind` must cover them. They are journaled by
 * `finalizeTaskMemory`, which the orchestrator MUST call before
 * `recorder.finalize()`: the recorder stops persisting once finalized, so a
 * record pushed afterwards stays in memory, is reported in the count, and
 * rewinds nothing.
 *
 * That failure is INVISIBLE to any in-memory assertion - `recorder.changes()`
 * contains the record either way. The only thing that can tell the two apart is
 * the JOURNAL FILE ON DISK, so that is what this reads. A pin written against
 * the in-memory array would have passed against the defect.
 */
describe('the run’s own end-of-task writes reach the PERSISTED journal', () => {
  function jsonResp(status: number, body: unknown): MockResp {
    return { statusCode: status, headers: {}, body: { json: () => Promise.resolve(body) } };
  }
  function sseResp(events: Array<Record<string, unknown>>): MockResp {
    const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: {
        json: () => Promise.resolve({}),
        [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
      },
    };
  }
  function scripted(replies: string[]) {
    let i = 0;
    return (url: string, init: { method: string }): MockResp => {
      if (init.method === 'GET' && url.includes('/auth/cli/whoami')) {
        return jsonResp(200, { success: true, data: { plan: 'pro', planDisplay: 'pro' } });
      }
      if (init.method === 'POST' && url.endsWith('/conversations')) return jsonResp(200, { success: true, data: { id: `cnv_${i}` } });
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        const reply = replies[i] ?? 'Done.';
        i += 1;
        return sseResp([{ type: 'text', content: reply }, { type: 'done' }]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
  }

  test('CODEBASE_CHANGELOG.md is in the session file on disk, not only in memory', async () => {
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    const homeDir = mkdtempSync(join(tmpdir(), 'spycli-journal-home-'));
    process.env.HOME = homeDir; // the command path reads the real homedir
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    writeFileSync(join(cwd, 'CODEBASE_CHANGELOG.md'), '# Codebase changelog\n\n');
    responder = scripted([block('write_file', { path: 'made.txt', content: 'agent\n' }), 'Done.']);

    const { Command } = await import('commander');
    const { registerAgentCommand } = await import('../src/commands/agent.js');
    const { configureOutput } = await import('../src/lib/output.js');
    const { latestSession } = await import('../src/lib/agent/checkpoint.js');
    configureOutput({ json: false, color: false });
    const program = new Command();
    program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
    registerAgentCommand(program);
    process.chdir(cwd);
    try {
      await program.parseAsync(['node', 'spycore', 'agent', 'do a thing', '-m', 'styx', '--no-plan', '--yes']);
    } finally {
      process.chdir(origCwd);
      responder = null;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(homeDir, { recursive: true, force: true });
    }

    // Control: the run really happened and really journaled the file write.
    const session = latestSession(cwd);
    expect(session, 'a session must have been persisted').not.toBeNull();
    const paths = session!.changes.map((c) => c.path);
    expect(paths, 'control - the ordinary write is journaled').toContain(join(cwd, 'made.txt'));

    // Subject: the run's OWN write to the user's changelog is journaled too.
    expect(
      paths,
      'CODEBASE_CHANGELOG.md was modified by the run and must be in the PERSISTED journal',
    ).toContain(join(cwd, 'CODEBASE_CHANGELOG.md'));
  }, 30_000);

  /**
   * THE FLAG REACHES THE LOOP - pinned through the REAL `agent` COMMAND.
   *
   * Every other opt-out test in this file passes `observeWorkspace` straight to
   * `runAgent`, so all of them would stay green if `commands/agent.ts` resolved
   * the flag and then forgot to pass it on. That is precisely the shape that
   * made a mutation surface read as 3 when it was 7: the census stopped where
   * the mechanism was obvious. This drives `spycore agent --no-observe` end to
   * end, through commander, through the command's resolver, into the loop.
   *
   * The control is in the same invocation: the file write MUST still be
   * journaled. A pin asserting only the absence would pass on a run that did
   * nothing at all.
   */
  test('END TO END - `agent --no-observe` reaches the loop, and the write still journals', async () => {
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    const homeDir = mkdtempSync(join(tmpdir(), 'spycli-journal-home-'));
    process.env.HOME = homeDir;
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    responder = scripted([
      block('write_file', { path: 'made.txt', content: 'agent\n' }),
      block('run_command', { command: 'rm victim.txt' }),
      'Done.',
    ]);

    const { Command } = await import('commander');
    const { registerAgentCommand } = await import('../src/commands/agent.js');
    const { configureOutput } = await import('../src/lib/output.js');
    const { latestSession } = await import('../src/lib/agent/checkpoint.js');
    configureOutput({ json: false, color: false });
    const program = new Command();
    program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
    registerAgentCommand(program);
    process.chdir(cwd);
    try {
      await program.parseAsync([
        'node', 'spycore', 'agent', 'do a thing', '-m', 'styx', '--no-plan', '--yes', '--no-observe',
      ]);
    } finally {
      process.chdir(origCwd);
      responder = null;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(homeDir, { recursive: true, force: true });
    }

    // Reached-assertions FIRST: both tool calls really happened on disk.
    expect(existsSync(join(cwd, 'made.txt')), 'the write really happened').toBe(true);
    expect(existsSync(join(cwd, 'victim.txt')), 'the command really ran').toBe(false);

    const session = latestSession(cwd);
    expect(session, 'a session must have been persisted').not.toBeNull();
    const paths = session!.changes.map((c) => c.path);
    expect(paths, 'CONTROL - the file-tool write is still journaled with --no-observe').toContain(
      join(cwd, 'made.txt'),
    );
    expect(
      paths,
      'the flag did not reach the loop - the opaque delete was journaled anyway',
    ).not.toContain(join(cwd, 'victim.txt'));
  }, 30_000);
});

/**
 * THE OPT-IN - DEFAULT **OFF**, AND PINNED AS A DEFAULT RATHER THAN AS A FLAG.
 *
 * The observer costs real time: measured through the real calls, ~30 ms per
 * opaque call on a 298-file package, ~375 ms on a 2,472-file monorepo and
 * ~1.4 s at the 20,000-file cap - twice per call, because the window takes a
 * before AND an after picture. A user who does not want the journal should not
 * pay it, so `--no-observe` / `agentObserveWorkspace=false` turns it off.
 *
 * R-CLI-1 - AND IT IS NOT ONLY TIME THAT IT COSTS. The observer
 * reads the FULL PLAINTEXT of every file the ignore rules do not hide and stores
 * it in an on-disk journal. The published `0.6.0` writes nothing of the kind, so
 * a user who merely UPDATES must not silently acquire a new on-disk archive of
 * their project. **The default is therefore OFF**, and `--observe` /
 * `agentObserveWorkspace=true` turns it on. NO CAPABILITY IS REMOVED - the
 * enabled path is pinned below and is unchanged.
 *
 * THE DEFAULT IS THE PART THAT MATTERS, and a default that flips silently is
 * the whole hazard IN EITHER DIRECTION - so the OFF state is asserted from an
 * ABSENT option and an ABSENT config key, not merely from passing `false`. If
 * someone changes `=== true` to a truthiness test, or flips the stored default,
 * these go red.
 *
 * AND BOTH DIRECTIONS RUN THE SAME SCRIPT. Each off-test asserts the effect
 * really happened on disk before reading the journal, so none can pass by the
 * command silently not running - which is the shape that made two of this
 * file's own pins darwin-only one batch ago.
 */
describe('the workspace observer is opt-in, and it defaults to OFF', () => {
  const RM = [block('run_command', { command: 'rm victim.txt' }), 'Done.'];

  /** Drive a run and return the journal AND everything it emitted. */
  async function runWithEvents(
    replies: string[],
    extra: Record<string, unknown> = {},
  ): Promise<{ changes: RecordedChange[]; notices: string[] }> {
    const changes: RecordedChange[] = [];
    const notices: string[] = [];
    await runAgent({
      task: 'observer pin',
      cwd,
      provider: new StubProvider(replies),
      requestApproval: ACCEPT,
      recordChange: (c) => changes.push(c),
      onEvent: (e: { type: string; text?: string }) => {
        if (e.type === 'hook_notice' && typeof e.text === 'string') notices.push(e.text);
      },
      // - the observer is OPT-IN since R-CLI-1, so every test that
      // exercises it must ASK for it. Placed before `...extra` so the
      // opt-out tests below still override it with `observeWorkspace: false`.
      observeWorkspace: true,
      ...extra,
    });
    return { changes, notices };
  }

  test(' : OFF by DEFAULT - no option, no config key: NOTHING is observed and NOTHING is written', async () => {
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    // The default must come from the ABSENCE of both controls, not from a false.
    expect(
      getConfigStore().get('agentObserveWorkspace'),
      'the shipped default must be OFF - the published 0.6.0 writes no such journal',
    ).toBe(false);

    // NOT through `runWithEvents`, which now opts IN on behalf of the tests
    // that exercise the observer. This one must see the shipped default.
    const changes: RecordedChange[] = [];
    const notices: string[] = [];
    await runAgent({
      task: 'observer default pin',
      cwd,
      provider: new StubProvider(RM),
      requestApproval: ACCEPT,
      recordChange: (c) => changes.push(c),
      onEvent: (e: { type: string; text?: string }) => {
        if (e.type === 'hook_notice' && typeof e.text === 'string') notices.push(e.text);
      },
    });

    // REACHED-ASSERTION FIRST: a zero journal means nothing unless the
    // command really ran. Without this the test passes when `rm` fails.
    expect(existsSync(join(cwd, 'victim.txt')), 'the command really ran').toBe(false);
    expect(
      changes.filter((c) => c.path === join(cwd, 'victim.txt')),
      'the shipped default must NOT journal the opaque delete',
    ).toHaveLength(0);
    // AND THE USER IS TOLD, rather than quietly getting a weaker rewind.
    expect(notices.join(' '), 'the run must say the observer is off').toContain(
      'workspace observation is off',
    );
    expect(notices.join(' '), 'and must say how to turn it on').toContain('--observe');

    // AND NOTHING IS WRITTEN AT ALL. The published `0.6.0` creates no such
    // journal, and a user who merely UPDATES must be in the same position. This
    // is asserted ON DISK rather than from the in-memory record, because the
    // exposure the decision is about is a FILE.
    const dir = join(dirname(getConfigPath()), 'checkpoints', sha256(cwd));
    expect(
      existsSync(dir),
      'no journal directory may be created for a run that only made opaque changes',
    ).toBe(false);
    expect(latestSession(cwd), 'and no session may be readable back').toBeNull();
  });

  test(' : NO CAPABILITY IS REMOVED - the enabled path still journals and still rewinds', async () => {
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    const { changes, notices } = await runWithEvents(RM, { observeWorkspace: true });
    expect(existsSync(join(cwd, 'victim.txt')), 'the command really ran').toBe(false);

    const forVictim = changes.filter((c) => c.path === join(cwd, 'victim.txt'));
    expect(forVictim, 'opted in, the opaque delete is journaled exactly as before').toHaveLength(1);
    expect(forVictim[0]!.op).toBe('delete');
    expect(rewind(changes).restored).toBe(1);
    expect(readFileSync(join(cwd, 'victim.txt'), 'utf8')).toBe('precious\n');
    expect(notices.join(' '), 'nothing is warned about when the observer is on').not.toContain(
      'workspace observation is off',
    );
  });

  test('OFF by flag - the command still works, and NOTHING is journaled for it', async () => {
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    const { changes } = await runWithEvents(RM, { observeWorkspace: false });

    // Reached-assertion FIRST: a zero journal is only meaningful if the command
    // actually deleted the file. Without this the test passes when `rm` fails.
    expect(existsSync(join(cwd, 'victim.txt')), 'the command really ran').toBe(false);
    expect(
      changes.filter((c) => c.path === join(cwd, 'victim.txt')),
      'the observer is off, so the opaque delete must not be journaled',
    ).toHaveLength(0);
  });

  test('OFF - file-tool writes are STILL journaled, and still rewind', async () => {
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    const { changes } = await runWithEvents(
      [
        block('write_file', { path: 'made.txt', content: 'agent\n' }),
        block('run_command', { command: 'rm victim.txt' }),
        'Done.',
      ],
      { observeWorkspace: false },
    );

    expect(existsSync(join(cwd, 'made.txt')), 'the write really happened').toBe(true);
    expect(existsSync(join(cwd, 'victim.txt')), 'the command really ran').toBe(false);

    // The precision claim the docs now make, as an assertion: OFF removes the
    // OPAQUE set, not the journal. A flag named for "no journal" would be false.
    expect(
      changes.map((c) => c.path),
      'a self-reporting tool keeps journaling when the observer is off',
    ).toContain(join(cwd, 'made.txt'));
    expect(changes.map((c) => c.path)).not.toContain(join(cwd, 'victim.txt'));

    expect(rewind(changes).restored, 'what IS journaled still rewinds').toBe(1);
    expect(existsSync(join(cwd, 'made.txt'))).toBe(false);
  });

  test('OFF - the run SAYS SO, exactly once, and never on a read-only turn', async () => {
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    writeFileSync(join(cwd, 'second.txt'), 'also\n');
    const { notices } = await runWithEvents(
      [
        block('run_command', { command: 'rm victim.txt' }),
        block('run_command', { command: 'rm second.txt' }),
        'Done.',
      ],
      { observeWorkspace: false },
    );
    expect(existsSync(join(cwd, 'victim.txt')), 'the first command really ran').toBe(false);
    expect(existsSync(join(cwd, 'second.txt')), 'the second command really ran').toBe(false);

    const said = notices.filter((n) => n.includes('workspace observation is off'));
    expect(said, 'two opaque calls, ONE notice - a per-call warning would be noise').toHaveLength(1);
    expect(said[0]!).toContain('rewind');

    // A read-only run has nothing to disclose and must stay silent.
    const readOnly = await runWithEvents([block('list_dir', { path: '.' }), 'Done.'], {
      observeWorkspace: false,
    });
    expect(
      readOnly.notices.filter((n) => n.includes('workspace observation is off')),
      'a run that mutated nothing must not warn about journaling',
    ).toHaveLength(0);
  });

  test('OFF by CONFIG KEY - the persisted setting reaches the loop through the resolver', async () => {
    getConfigStore().set('agentObserveWorkspace', false);
    const observe = resolveObserveWorkspaceEnabled(
      undefined,
      getConfigStore().get('agentObserveWorkspace'),
    );
    expect(observe, 'the stored false must resolve to off with no flag present').toBe(false);

    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    const { changes } = await runWithEvents(RM, { observeWorkspace: observe });
    expect(existsSync(join(cwd, 'victim.txt')), 'the command really ran').toBe(false);
    expect(changes.filter((c) => c.path === join(cwd, 'victim.txt'))).toHaveLength(0);
  });

  /**
   * The resolver's whole table, including the shapes that must NOT turn it
   * off. `!== false` is a deliberate choice over truthiness: an absent key, an
   * absent flag and a non-boolean both leave the safety net on.
   */
  test('the resolver: an explicit flag wins in EITHER direction, and only a literal true turns it on', () => {
    expect(resolveObserveWorkspaceEnabled(undefined, undefined), 'nothing set → OFF').toBe(false);
    expect(resolveObserveWorkspaceEnabled(undefined, true), 'key true → ON').toBe(true);
    expect(resolveObserveWorkspaceEnabled(undefined, false), 'key false → OFF').toBe(false);
    expect(resolveObserveWorkspaceEnabled(true, undefined), '--observe → ON').toBe(true);
    expect(resolveObserveWorkspaceEnabled(false, undefined), '--no-observe → OFF').toBe(false);
    expect(resolveObserveWorkspaceEnabled(false, true), '--no-observe beats a stored true').toBe(false);
    // THE SEMANTIC THAT CHANGED, AND THE MEASUREMENT THAT LICENSES IT.
    // Before R-CLI-1 only `--no-observe` was declared, so commander set
    // `observe` to `true` on an EMPTY argv and `true` could not mean "the user
    // asked". Measured with both flags declared: [] → undefined, --observe →
    // true, --no-observe → false. It is a genuine tri-state now, so an explicit
    // `--observe` may override a stored false.
    expect(
      resolveObserveWorkspaceEnabled(true, false),
      '--observe is now an explicit signal and beats a stored false',
    ).toBe(true);
    expect(
      resolveObserveWorkspaceEnabled(undefined, 'yes'),
      'a non-boolean key is NOT a true - the default is off',
    ).toBe(false);
  });

  test('the config key is settable, validated, and listed like every other switch', () => {
    expect(isKnownKey('agentObserveWorkspace'), '`config set` must accept it').toBe(true);
    expect(listKnownKeys(), '`config list` must show it - an unlisted switch is undiscoverable').toContain(
      'agentObserveWorkspace',
    );
    expect(coerceValue('agentObserveWorkspace', 'false')).toBe(false);
    expect(coerceValue('agentObserveWorkspace', 'true')).toBe(true);
    expect(() => coerceValue('agentObserveWorkspace', 'nope')).toThrow(/true.*false/);
  });
});

/**
 * R-CLI-1 - THE TWO PROPERTIES THE OBSERVER'S JOURNAL MUST HAVE
 * ONCE SOMEBODY HAS OPTED IN.
 *
 * Turning the observer OFF by default protects the user who never asks for it.
 * These two protect the user who DOES. Both are pinned separately from the
 * default, because a default is a product decision and these are properties of
 * the mechanism - closing one and calling the class closed is the shape this
 * repository has paid for repeatedly.
 */
describe(' · what the journal must never contain, and who may read it', () => {
  /**
   * THE SECRET GUARD, AT THE ELEVENTH READER.
   *
   * The observer reads the full plaintext of every file the ignore rules do not
   * hide. Every OTHER file-content reader in this package consults
   * `loadSecretGuard` first; this one did not, so a credential file that is
   * simply NOT gitignored had its plaintext copied into an on-disk journal.
   *
   * THE FIXTURE IS THE POINT: `.env.local` is NOT in `.gitignore` here. The
   * previous behaviour's stated mitigation was "a gitignored `.env` is safe",
   * and that mitigation is exactly what this file does not have.
   */
  test('a NON-gitignored credential file is DETECTED but its plaintext is never journaled', async () => {
    const SECRET = 'STRIPE_SECRET_KEY=sk_live_PINPINPINPINPINPINPIN\n';
    writeFileSync(join(cwd, '.env.local'), SECRET);
    writeFileSync(join(cwd, 'ordinary.txt'), 'before\n');
    // no .gitignore at all - the case the old mitigation could not cover

    const changes = await run(
      [
        block('run_command', {
          command: 'printf "STRIPE_SECRET_KEY=sk_live_CHANGEDCHANGEDCHANGED\\n" > .env.local; printf "after\\n" > ordinary.txt',
        }),
        'Done.',
      ],
      { observeWorkspace: true },
    );

    // REACHED-ASSERTION FIRST - a clean journal means nothing if the command
    // never ran. Both files must really have changed on disk.
    expect(readFileSync(join(cwd, '.env.local'), 'utf8'), 'the command really rewrote the secret file').not.toBe(SECRET);
    expect(readFileSync(join(cwd, 'ordinary.txt'), 'utf8'), 'the command really rewrote the ordinary file').toBe('after\n');

    // THE POSITIVE CONTROL, in the same invocation: the ORDINARY file IS
    // journaled with its content. Without this, a journal that captured nothing
    // at all would pass the assertion below.
    const ordinary = changes.filter((c) => c.path === join(cwd, 'ordinary.txt'));
    expect(ordinary, 'the ordinary file must still be journaled - this is the positive control').toHaveLength(1);
    expect(ordinary[0]!.before).toBe('before\n');

    // AND THE SECRET FILE CONTRIBUTES NO PLAINTEXT, in either direction.
    const journal = JSON.stringify(changes);
    expect(journal, 'the old secret must not reach the journal').not.toContain('sk_live_PINPINPIN');
    expect(journal, 'nor the new one').not.toContain('sk_live_CHANGEDCHANGED');
    expect(
      changes.filter((c) => c.path === join(cwd, '.env.local')),
      'a secret file must contribute NO journal record at all',
    ).toHaveLength(0);
  }, 30_000);

  /**
   * THE FILE MODE. The journal holds the BEFORE and AFTER text of every
   * file a run changed, and it was written with no `mode` argument - so it
   * landed at the process umask, commonly world-readable.
   *
   * The numbers are not invented: they are the ones this package already
   * applies to the file holding the bearer token (`lib/config.ts`), and the
   * journal lives under that same configuration directory.
   *
   * Skipped on Windows, where POSIX permission bits are not modelled.
   */
  test.skipIf(process.platform === 'win32')(
    'the journal file is owner-only, and so is every directory this module creates',
    () => {
      const id = saveSession({
        cwd,
        task: 'mode pin',
        changes: [{ path: join(cwd, 'f.txt'), op: 'modify', before: 'a\n', after: 'b\n' }],
      });
      expect(id, 'the journal must actually have been written').not.toBeNull();

      const session = latestSession(cwd);
      expect(session, 'and must be readable back').not.toBeNull();

      const root = join(dirname(getConfigPath()), 'checkpoints');
      const dir = join(root, sha256(cwd));
      const file = join(dir, `${id}.json`);
      expect(existsSync(file), 'the journal file must exist at its own path').toBe(true);

      const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);
      expect(mode(file), 'the journal file must be owner-only').toBe('600');
      expect(mode(dir), 'the per-workspace directory must be owner-only').toBe('700');
      // EVERY level, not only the leaf: an owner-only file inside a
      // world-readable directory still leaks the name of every observed
      // workspace.
      expect(mode(root), 'the checkpoints root must be owner-only too').toBe('700');
    },
  );
});

/**
 * R-CLI-1 - THE FLAG PAIR IS WHAT MAKES THE DEFAULT REACHABLE,
 * AND IT IS PINNED SEPARATELY FROM THE RESOLVER.
 *
 * The resolver reads `observeFlag === true` as "the user asked for it". That is
 * only sound because BOTH `--observe` and `--no-observe` are declared: with only
 * the negated form declared, commander sets the option to `true` on an EMPTY
 * argv, so every run would look like an explicit opt-in and the default would be
 * defeated at the front door.
 *
 * Measured with a control, and pinned here because deleting `--observe` as
 * "redundant" is the single most plausible way to silently flip the default back
 * ON for every user without touching the resolver or the stored default.
 */
describe(' · the agent flag pair is a genuine tri-state', () => {
  function parse(argv: string[]): unknown {
    const program = new Command();
    program.exitOverride();
    registerAgentCommand(program);
    const agent = program.commands.find((c) => c.name() === 'agent');
    expect(agent, 'the agent command must be registered').toBeDefined();
    // Parse options WITHOUT running the action.
    agent!.parseOptions(argv);
    return (agent!.opts() as Record<string, unknown>).observe;
  }

  test('no flag yields UNDEFINED, not true - the default must survive an empty argv', () => {
    expect(parse([]), 'an empty argv must not look like an opt-in').toBeUndefined();
  });

  test('--observe yields true and --no-observe yields false', () => {
    expect(parse(['--observe']), '--observe must be an explicit yes').toBe(true);
    expect(parse(['--no-observe']), '--no-observe must be an explicit no').toBe(false);
  });

  test(' end to end: an empty argv resolves to OFF, --observe resolves to ON', () => {
    expect(resolveObserveWorkspaceEnabled(parse([]) as boolean | undefined, undefined)).toBe(false);
    expect(resolveObserveWorkspaceEnabled(parse(['--observe']) as boolean | undefined, undefined)).toBe(true);
    expect(resolveObserveWorkspaceEnabled(parse(['--no-observe']) as boolean | undefined, true)).toBe(false);
  });
});

/**
 * R-CLI-1 - THE GUARD PINNED AT EACH CAPTURE SITE INDIVIDUALLY,
 * BECAUSE THE SITES MASK EACH OTHER.
 *
 * The end-to-end pin above is the COMPOSED proof: with every guard removed, four
 * of four fixture secrets reach the journal. But removing ONE guard reddens
 * NOTHING end to end, and the reason is a property of the design rather than of
 * the test: the snapshot pass stores `content: null` for a secret file, and the
 * diff pass independently routes a secret path to `uncaptured` - so each site
 * covers the other's removal. Measured, both arms individually inert.
 *
 * Defence in depth is worth having, and an unverifiable control is not. So
 * each site is driven DIRECTLY here, where the masking cannot happen. This is
 * the same shape as two defects at one site hiding each other, read from the
 * other direction: two CONTROLS at one site can hide each other's absence.
 */
describe(' · each capture site consults the guard, pinned where masking cannot hide it', () => {
  test('the SNAPSHOT pass retains no secret plaintext, and still hashes it so a change is DETECTED', async () => {
    const { snapshotWorkspace } = await import('../src/lib/agent/workspace-delta.js');
    writeFileSync(join(cwd, '.env.local'), 'STRIPE_SECRET_KEY=sk_live_SNAPPIN\n');
    writeFileSync(join(cwd, 'credentials.json'), '{"token":"sk_live_SNAPPIN2"}\n');
    writeFileSync(join(cwd, 'ordinary.txt'), 'before\n');

    const snap = await snapshotWorkspace(cwd);
    expect(snap, 'the snapshot must have been taken').not.toBeNull();

    // POSITIVE CONTROL FIRST: an ordinary file IS retained. Without it a
    // snapshot that captured nothing would satisfy every assertion below.
    expect(snap!.entries.get('ordinary.txt')?.content, 'the ordinary file must be retained').toBe('before\n');

    for (const secret of ['.env.local', 'credentials.json']) {
      const e = snap!.entries.get(secret);
      expect(e, `${secret} must still be ENUMERATED - dropping it would hide the change`).toBeDefined();
      expect(e!.content, `${secret} must contribute NO plaintext`).toBeNull();
      expect(e!.sha, `${secret} must still be hashed so a change is detectable`).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify([...snap!.entries.values()])).not.toContain('sk_live_SNAPPIN');
  }, 30_000);

  test('the DIFF pass refuses a secret file CREATED inside the window - the case with no prior entry', async () => {
    const { snapshotWorkspace, diffWorkspace } = await import('../src/lib/agent/workspace-delta.js');
    writeFileSync(join(cwd, 'ordinary.txt'), 'before\n');
    const snap = await snapshotWorkspace(cwd);
    expect(snap).not.toBeNull();

    // created AFTER the snapshot: no prior entry at all, so the snapshot pass's
    // guard cannot be what protects it.
    writeFileSync(join(cwd, 'credentials.json'), '{"token":"sk_live_DIFFPIN"}\n');
    writeFileSync(join(cwd, 'ordinary.txt'), 'after\n');

    const delta = await diffWorkspace(snap!, new Set());
    // POSITIVE CONTROL: the ordinary edit IS journaled with its content.
    const ord = delta.changes.filter((c) => c.path.endsWith('ordinary.txt'));
    expect(ord, 'the ordinary change must be journaled - this is the positive control').toHaveLength(1);
    expect(ord[0]!.after).toBe('after\n');

    expect(
      delta.changes.filter((c) => c.path.endsWith('credentials.json')),
      'a secret file created inside the window must contribute no record',
    ).toHaveLength(0);
    expect(delta.uncaptured, 'and it must be REPORTED, not silently dropped').toContain('credentials.json');
    expect(JSON.stringify(delta.changes)).not.toContain('sk_live_DIFFPIN');
  }, 30_000);

  test('the PAUSE rebase refuses a secret file too', async () => {
    const { snapshotWorkspace, openPause, closePause } = await import('../src/lib/agent/workspace-delta.js');
    writeFileSync(join(cwd, 'credentials.json'), '{"token":"sk_live_PAUSE1"}\n');
    writeFileSync(join(cwd, 'ordinary.txt'), 'before\n');
    const snap = await snapshotWorkspace(cwd);
    expect(snap).not.toBeNull();

    const census = await openPause(snap!);
    // a "foreign" edit during the pause, to both files
    writeFileSync(join(cwd, 'credentials.json'), '{"token":"sk_live_PAUSE2"}\n');
    writeFileSync(join(cwd, 'ordinary.txt'), 'during\n');
    await closePause(snap!, census);

    // POSITIVE CONTROL: the ordinary file's baseline really was rebased.
    expect(snap!.entries.get('ordinary.txt')?.content, 'the ordinary rebase must have happened').toBe('during\n');
    expect(
      snap!.entries.get('credentials.json')?.content,
      'the rebase must not pull secret plaintext into the baseline',
    ).toBeNull();
    expect(JSON.stringify([...snap!.entries.values()])).not.toContain('sk_live_PAUSE');
  }, 30_000);
});
