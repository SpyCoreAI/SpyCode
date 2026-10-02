/**
 * THE OBSERVATION WINDOW'S SPAN AND ITS OUTPUT — pinned by EXECUTION.
 *
 * ⭐⭐ WHY THIS FILE EXISTS. Review 3 filed three findings against the workspace
 * observer and the run recorder, and the register treats them as one gating item:
 *
 *   C-LC8   the observation window encloses the approval prompt
 *   C-UX45  the recorder was measured O(N²)
 *   C-UX47  one hook opens a full enumerate+hash window around EVERY dispatch
 *
 * Measured at the predecessor commit by driving `runAgent`, all three reproduce,
 * and the first is NOT a timing curiosity. It is a DATA-LOSS path:
 *
 *     run_command `true`            — the command itself mutates NOTHING
 *     while the prompt was open     — the user edits mine.txt and adds a note
 *     journaled as this call's work : mine.txt:modify  my-new-note.txt:create
 *     planRewind                    : mine.txt:restore  my-new-note.txt:delete
 *     applyRewind                   : restored=2 skipped=0
 *     mine.txt afterwards           : the user's typing REVERTED
 *     my-new-note.txt afterwards    : DELETED
 *
 * ⭐⭐ AND THE SHIPPED SENTENCE THAT NAMED THIS CASE PROMISED A GUARD THAT CANNOT
 * FIRE. `SECURITY.md` said the comparison "cannot distinguish the command's writes
 * from an edit you made in another window during the same seconds; the restore
 * guard is what protects you, skipping any file whose content is not what the run
 * left." The guard compares the file's current sha against the journal's
 * `afterSha`. When the foreign edit happens INSIDE the window, the foreign content
 * IS `after` — so the shas match, the guard passes, and the restore proceeds. The
 * guard protects against an edit made AFTER the run. It is structurally blind to
 * one made DURING it, which is the only case the sentence named.
 *
 * ⭐ EVERY ATTRIBUTION TEST DRIVES `runAgent` AND MAKES ITS FOREIGN CHANGE FROM
 * INSIDE `requestApproval`. That is the only way to be inside the real window at
 * the real moment; a test that called `snapshotWorkspace`/`diffWorkspace` directly
 * would prove the primitives work and say nothing about the span the loop opens.
 *
 * ⭐ THE COVERAGE HALF IS A FENCE, NOT A DECORATION. Narrowing the window is the
 * obvious fix and it silently deletes journal coverage: the pre-tool hook runs
 * BEFORE the approval prompt (measured — at the prompt, the pre-hook's file is
 * already on disk), so a snapshot taken after approval drops it, falsifying
 * `SECURITY.md`'s "Only pre-tool and post-tool hooks are covered". Every coverage
 * cell below was GREEN before the fix and must stay green.
 *
 * ⭐ THE CORPUS IS NOT DERIVED FROM WHAT THE OBSERVER MEASURES. The foreign-change
 * grid is written from the OUTSIDE — the three filesystem operations a second
 * writer can perform (create, modify, delete) × the two decisions a human can
 * make × the two window-opening tool shapes — not from the observer's own notion
 * of a change. A dimension the observer stops handling therefore reddens here.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ THE PERSIST COUNTER, AND WHY IT REPLACES THE MODULE RATHER THAN PATCHING IT.
 *
 * `checkpoint.ts` does `import { renameSync } from 'node:fs'`, so the binding is
 * resolved at load time: patching the `fs` OBJECT would be invisible to it —
 * F-2c-34 paid for that lesson with `readFileSync`. Replacing the MODULE means the
 * bound value IS the counting wrapper. `renameSync` is the journal's atomic commit
 * step and runs exactly once per `persist()`, so this is an EXACT persist count
 * with no timing in it. Everything else passes straight through to the real fs.
 */
const renames: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    renameSync: (from: Parameters<typeof real.renameSync>[0], to: Parameters<typeof real.renameSync>[1]) => {
      renames.push(String(to));
      return real.renameSync(from, to);
    },
  };
});
vi.mock('undici', () => ({
  request: vi.fn(async () => {
    throw new Error('this file never speaks HTTP');
  }),
}));

import { freshConfigDir } from './helpers.js';
import { runAgent } from '../src/lib/agent/loop.js';
import {
  applyRewind,
  createRunRecorder,
  planRewind,
  sha256,
  type CheckpointSession,
  type RecordedChange,
} from '../src/lib/agent/checkpoint.js';
import { DELTA_MAX_FILES } from '../src/lib/agent/workspace-delta.js';
import { writeScope } from '../src/lib/agent/mcp-config.js';
import { trustWorkspace } from '../src/lib/config.js';
import { createAgentHooksBridge, loadHookSession } from '../src/lib/hooks.js';
import type { Provider, ProviderEvent } from '../src/lib/providers/types.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';

const WRITER_FIXTURE = fileURLToPath(new URL('./fixtures/mcp-writer-server.mjs', import.meta.url));
const BUDGET0 = { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} };
const RESUME0 = {
  providerKind: 'byok' as const,
  model: 'm',
  planMode: false,
  maxTurns: 1,
  budget: BUDGET0,
  gitHead: null,
};

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
    yield { type: 'text', text: this.replies[this.turn++] ?? 'Done.' };
    yield { type: 'usage', input: 1, output: 1 };
    yield { type: 'done' };
  }
}

let cwd: string;
let scriptDir: string;

beforeEach(() => {
  renames.length = 0;
  freshConfigDir();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-observer-')));
  // Hook scripts live OUTSIDE the workspace, so a script is never itself a change.
  scriptDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-obs-hook-')));
});

afterEach(async () => {
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  for (const d of [cwd, scriptDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/**
 * A hook command that writes a file. ⭐ A SCRIPT FILE, not `node -e "…"`: the
 * command is handed to `sh -c`, and a `-e` program carrying its own double quotes
 * does not survive nesting inside a double-quoted shell word. The first version of
 * this helper silently did nothing and the probe reported "the pre-tool hook's
 * write was not journaled" — a negative reading manufactured entirely by the
 * instrument. Every hook arm below asserts its hook really ran.
 */
function hookWriting(name: string, target: string, body: string): string {
  const script = join(scriptDir, name);
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(body)});\n`, 'utf8');
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

async function bridgeFor(hooks: Array<{ event: string; command: string }>): Promise<ReturnType<typeof createAgentHooksBridge>> {
  mkdirSync(join(cwd, '.spycore'), { recursive: true });
  writeFileSync(join(cwd, '.spycore', 'hooks.json'), JSON.stringify({ hooks }));
  trustWorkspace(cwd);
  const session = await loadHookSession(cwd, { approveProjectHook: () => Promise.resolve(true) });
  return createAgentHooksBridge(session);
}

/** Drive a real run and return everything it journaled. */
async function drive(
  replies: string[],
  extra: Record<string, unknown> = {},
): Promise<RecordedChange[]> {
  const changes: RecordedChange[] = [];
  await runAgent({
    task: 'observer pin',
    cwd,
    provider: new StubProvider(replies),
    requestApproval: (() => Promise.resolve({ approved: true })) as RequestApproval,
    recordChange: (c: RecordedChange) => changes.push(c),
    // ⭐ `SPY-416` — the observer is OPT-IN since R-CLI-1, so every test that
    // exercises it must ASK for it. Placed before `...extra` so the
    // opt-out tests below still override it with `observeWorkspace: false`.
    observeWorkspace: true,
    ...extra,
  });
  return changes;
}

// ===========================================================================
// 1. ATTRIBUTION — the foreign-change grid. C-LC8.
// ===========================================================================

/** The three filesystem operations a SECOND writer can perform. Written from the
 *  outside: this list is the operating system's, not the observer's. */
const FOREIGN_OPS = ['create', 'modify', 'delete'] as const;
type ForeignOp = (typeof FOREIGN_OPS)[number];

/** The two decisions a human at the prompt can make. Both keep the window open. */
const DECISIONS = [true, false] as const;

/** The two shapes that open a window around a prompting call. */
const WINDOW_SHAPES = ['opaque-command', 'file-tool-with-hook'] as const;
type WindowShape = (typeof WINDOW_SHAPES)[number];

/** Prepare the foreign target, and return the mutation a second writer makes. */
function foreignTarget(op: ForeignOp): { path: string; original: string | null; mutate: () => void } {
  const path = join(cwd, `foreign-${op}.txt`);
  if (op === 'create') {
    return { path, original: null, mutate: () => writeFileSync(path, 'the user typed this while deciding\n') };
  }
  const original = `the user's work, before the prompt (${op})\n`;
  writeFileSync(path, original);
  if (op === 'modify') {
    return { path, original, mutate: () => writeFileSync(path, 'the user EDITED this while deciding\n') };
  }
  return { path, original, mutate: () => rmSync(path, { force: true }) };
}

describe('C-LC8 · the window must not attribute a change made while the prompt was open', () => {
  for (const shape of WINDOW_SHAPES) {
    for (const op of FOREIGN_OPS) {
      for (const approved of DECISIONS) {
        test(`${shape} · a foreign ${op} during the prompt (${approved ? 'approved' : 'denied'}) is NOT journaled`, async () => {
          const target = foreignTarget(op);
          let prompted = 0;
          const approve: RequestApproval = () => {
            prompted += 1;
            target.mutate();
            return Promise.resolve({ approved });
          };

          const extra: Record<string, unknown> = { requestApproval: approve };
          let replies: string[];
          if (shape === 'opaque-command') {
            replies = [block('run_command', { command: 'true' }), 'Done.'];
          } else {
            // A file tool only opens a window when a hook is configured, and a
            // hook is an ordinary user setup.
            extra['hooks'] = await bridgeFor([{ event: 'post-tool', command: 'true' }]);
            replies = [block('write_file', { path: 'agent-made.txt', content: 'agent\n' }), 'Done.'];
          }

          const changes = await drive(replies, extra);

          expect(prompted, 'the prompt must actually have opened — else this cell proves nothing').toBeGreaterThan(0);
          const attributed = changes.filter((c) => c.path === target.path);
          expect(
            attributed.map((c) => c.op),
            `a ${op} made by someone else while the prompt was open must not be journaled as this call's work`,
          ).toEqual([]);
        });
      }
    }
  }

  /**
   * ⭐ THE FLOOR THAT BINDS THE GRID TO THE CORPUS IT READS. Emptying a dimension
   * above would delete cells rather than fail them: vitest reports fewer tests, not
   * a red. So the shape of the population is asserted, not left implicit.
   */
  test('FLOOR — the grid really is 3 operations x 2 decisions x 2 window shapes', () => {
    expect(FOREIGN_OPS).toEqual(['create', 'modify', 'delete']);
    expect(DECISIONS).toEqual([true, false]);
    expect(WINDOW_SHAPES).toEqual(['opaque-command', 'file-tool-with-hook']);
    expect(FOREIGN_OPS.length * DECISIONS.length * WINDOW_SHAPES.length).toBe(12);
  });

  /**
   * ⭐⭐ THE LEG THAT CATCHES A CENSUS COMPARING ONLY SIZE — asked as "which
   * re-wrap of this fix would pass every cell above?"
   *
   * Every foreign-modify cell above changes the byte length, so a census that
   * compared `size` alone and ignored `mtimeMs` would pass all twelve. A
   * same-length edit is not exotic: correcting one character is the most ordinary
   * edit there is.
   */
  test('⭐ a foreign modify of the SAME byte length during the prompt is not journaled', async () => {
    const target = join(cwd, 'same-length.txt');
    writeFileSync(target, 'the colour is grey\n');
    const changes = await drive([block('run_command', { command: 'true' }), 'Done.'], {
      requestApproval: (() => {
        // Same number of bytes, different bytes — a one-character correction.
        writeFileSync(target, 'the colour is gray\n');
        return Promise.resolve({ approved: true });
      }) as RequestApproval,
    });
    expect(readFileSync(target, 'utf8'), 'the foreign edit really happened').toBe('the colour is gray\n');
    expect(
      changes.some((c) => c.path === target),
      'a census keyed on size alone would attribute this',
    ).toBe(false);
  });

  /**
   * ⭐⭐ THE SEVERITY LEG. The grid above says "not journaled". This says what
   * being journaled COSTS, and it is the reason this is not cosmetic: the journal
   * is executable. `spycore rewind` reads it and writes bytes back.
   */
  test('⭐ the user\'s concurrent work SURVIVES a rewind of the run that prompted', async () => {
    writeFileSync(join(cwd, 'mine.txt'), 'MY WORK v1\n');
    const note = join(cwd, 'my-new-note.txt');
    const typed = 'MY WORK v2 — typed while the prompt was up\n';

    const changes = await drive([block('run_command', { command: 'true' }), 'Done.'], {
      requestApproval: (() => {
        writeFileSync(join(cwd, 'mine.txt'), typed);
        writeFileSync(note, 'a note I wrote while deciding\n');
        return Promise.resolve({ approved: true });
      }) as RequestApproval,
    });

    const session: CheckpointSession = {
      id: '1-pin',
      cwd,
      startedAt: new Date(0).toISOString(),
      task: 'observer pin',
      changes: changes.map((c) => ({ ...c, afterSha: sha256(c.after) })),
    };
    applyRewind(planRewind(session), cwd);

    expect(readFileSync(join(cwd, 'mine.txt'), 'utf8'), 'rewind must not revert an edit the run did not make').toBe(typed);
    expect(existsSync(note), 'rewind must not delete a file the run did not create').toBe(true);
  });

  /**
   * ⭐ THE CONTROL FOR THE WHOLE GRID. The same foreign changes, made BEFORE the
   * run starts, belong to the before-picture and are already not journaled. If
   * this ever fails, every cell above is passing for the wrong reason.
   */
  test('CONTROL — the same changes made BEFORE the run are not journaled either', async () => {
    writeFileSync(join(cwd, 'pre.txt'), 'v1\n');
    writeFileSync(join(cwd, 'pre.txt'), 'v2\n');
    writeFileSync(join(cwd, 'pre-new.txt'), 'made before\n');
    const changes = await drive([block('run_command', { command: 'true' }), 'Done.']);
    expect(changes, 'a `true` command with no concurrent writer journals nothing').toEqual([]);
  });

  /**
   * ⭐⭐ THE LEG ONLY A PLANT CAN CATCH — asked as "which re-wrap of this fix would
   * pass every cell above?"
   *
   * Answer: one that re-bases the baseline's CONTENT for a path the user touched
   * but forgets its PRESENCE bookkeeping. Every cell above then still passes,
   * because a foreign create is absent from `entries` either way. The cell that
   * catches it is a foreign create followed by the COMMAND modifying that same
   * path: the path must be journaled as a `modify` against the user's content, not
   * as a `create` — because a `create` record makes `rewind` DELETE it.
   */
  test('⭐ a foreign CREATE the command then MODIFIES is journaled as modify, not create', async () => {
    const shared = join(cwd, 'shared.txt');
    const userText = 'the user created this while deciding\n';
    const writer = join(scriptDir, 'append.js');
    writeFileSync(
      writer,
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(shared)}, fs.readFileSync(${JSON.stringify(shared)},'utf8') + 'and the command appended this\\n');\n`,
      'utf8',
    );

    const changes = await drive(
      [block('run_command', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(writer)}` }), 'Done.'],
      {
        requestApproval: (() => {
          writeFileSync(shared, userText);
          return Promise.resolve({ approved: true });
        }) as RequestApproval,
      },
    );

    const rec = changes.find((c) => c.path === shared);
    expect(rec, "the command's own write must still be journaled").toBeDefined();
    expect(rec!.op, 'a create record would make rewind DELETE the user\'s file').toBe('modify');
    expect(rec!.before, "and its `before` must be what the user had, not nothing").toBe(userText);

    // And rewinding must leave the user's file present, holding the user's text.
    const session: CheckpointSession = {
      id: '2-pin',
      cwd,
      startedAt: new Date(0).toISOString(),
      task: 'observer pin',
      changes: changes.map((c) => ({ ...c, afterSha: sha256(c.after) })),
    };
    applyRewind(planRewind(session), cwd);
    expect(existsSync(shared), 'rewind must not delete it').toBe(true);
    expect(readFileSync(shared, 'utf8'), 'rewind restores the user\'s content, not absence').toBe(userText);
  });
});

// ===========================================================================
// 2. COVERAGE — the fence. Every cell was GREEN before the fix.
// ===========================================================================
describe('the window\'s coverage is unchanged — narrowing it would delete a control', () => {
  /**
   * ⭐⭐ THE CELL THAT KILLS THE OBVIOUS FIX. The pre-tool hook fires BEFORE the
   * approval prompt — measured: at the prompt, the hook's file is already on disk.
   * So "take the snapshot after approval" drops pre-tool-hook writes out of the
   * journal and falsifies SECURITY.md's "Only pre-tool and post-tool hooks are
   * covered". This cell is why the fix re-bases a baseline instead of moving it.
   */
  test('⭐ a PRE-tool hook writes BEFORE the prompt, and its write is still journaled', async () => {
    const made = join(cwd, 'pre-hook-made.txt');
    const hooks = await bridgeFor([{ event: 'pre-tool', command: hookWriting('pre.js', made, 'from the pre-tool hook\n') }]);
    expect(hooks.hasAny).toBe(true);

    let onDiskAtPrompt: boolean | null = null;
    const changes = await drive([block('run_command', { command: 'true' }), 'Done.'], {
      hooks,
      requestApproval: (() => {
        onDiskAtPrompt = existsSync(made);
        return Promise.resolve({ approved: true });
      }) as RequestApproval,
    });

    expect(existsSync(made), 'the hook must really have written — else this cell proves nothing').toBe(true);
    expect(onDiskAtPrompt, 'the pre-tool hook runs BEFORE the prompt — that is the constraint').toBe(true);
    expect(
      changes.some((c) => c.path === made),
      "the pre-tool hook's write must stay journaled",
    ).toBe(true);
  });

  test('a POST-tool hook\'s write is still journaled', async () => {
    const made = join(cwd, 'post-hook-made.txt');
    const hooks = await bridgeFor([{ event: 'post-tool', command: hookWriting('post.js', made, 'from the post-tool hook\n') }]);
    const changes = await drive([block('run_command', { command: 'true' }), 'Done.'], { hooks });
    expect(existsSync(made), 'the hook must really have written').toBe(true);
    expect(changes.some((c) => c.path === made)).toBe(true);
  });

  /**
   * ⭐ C-UX47's SUBJECT, PINNED AS COVERAGE. One hook opens a window around every
   * dispatch, reads included — and that is why a hook's write around a READ-ONLY
   * call reaches the journal. The trigger is expensive (measured: 3 reads on a
   * 1,200-file workspace cost 287 ms with a hook and 4 ms without) and it cannot
   * be narrowed without deleting exactly this cell.
   */
  test('⭐ C-UX47 · a hook\'s write around a READ-ONLY call is journaled', async () => {
    const made = join(cwd, 'hook-around-read.txt');
    writeFileSync(join(cwd, 'readme.txt'), 'read me\n');
    const hooks = await bridgeFor([{ event: 'post-tool', command: hookWriting('read.js', made, 'written around a read\n') }]);
    const changes = await drive([block('read_file', { path: 'readme.txt' }), 'Done.'], { hooks });
    expect(existsSync(made), 'the hook must really have written').toBe(true);
    expect(
      changes.some((c) => c.path === made),
      'narrowing the window to mutating tools would delete this record',
    ).toBe(true);
  });

  test('run_command create + modify + delete are all still journaled', async () => {
    writeFileSync(join(cwd, 'target.txt'), 'aaa\n');
    writeFileSync(join(cwd, 'victim.txt'), 'precious\n');
    const script = join(scriptDir, 'three.js');
    writeFileSync(
      script,
      `const fs=require('fs'),p=require('path'),d=${JSON.stringify(cwd)};
       fs.writeFileSync(p.join(d,'made.txt'),'made\\n');
       fs.writeFileSync(p.join(d,'target.txt'),'zzz\\n');
       fs.rmSync(p.join(d,'victim.txt'));\n`,
      'utf8',
    );
    const changes = await drive(
      [block('run_command', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }), 'Done.'],
      {},
    );
    const ops = new Map(changes.map((c) => [c.path, c.op]));
    expect(ops.get(join(cwd, 'made.txt'))).toBe('create');
    expect(ops.get(join(cwd, 'target.txt'))).toBe('modify');
    expect(ops.get(join(cwd, 'victim.txt'))).toBe('delete');
  });

  test('write_file still journals EXACTLY ONE record, with and without a hook', async () => {
    const plain = await drive([block('write_file', { path: 'a.txt', content: 'x\n' }), 'Done.']);
    expect(plain.filter((c) => c.path === join(cwd, 'a.txt'))).toHaveLength(1);

    const hooks = await bridgeFor([{ event: 'post-tool', command: 'true' }]);
    const hooked = await drive([block('write_file', { path: 'b.txt', content: 'y\n' }), 'Done.'], { hooks });
    expect(
      hooked.filter((c) => c.path === join(cwd, 'b.txt')),
      'the tool reported it AND the window saw it — one record, not two',
    ).toHaveLength(1);
  });

  test('an MCP tool\'s write is still journaled', async () => {
    writeScope('project', cwd, [{ name: 'w', command: process.execPath, args: [WRITER_FIXTURE] }]);
    trustWorkspace(cwd);
    const target = join(cwd, 'mcp-made.txt');
    const changes = await drive([block('mcp__w__write_probe', { path: target, text: 'from-mcp\n' }), 'Done.']);
    expect(existsSync(target), 'the MCP server really wrote it').toBe(true);
    expect(changes.some((c) => c.path === target)).toBe(true);
  });

  /**
   * ⭐ AND THE BARRIER MUST NOT BREAK THIS. An MCP call is gated through the same
   * approval channel, so it traverses the barrier too — with a foreign change made
   * while its prompt is open.
   */
  test('⭐ an MCP call: its own write journaled, the foreign one during its prompt not', async () => {
    writeScope('project', cwd, [{ name: 'w', command: process.execPath, args: [WRITER_FIXTURE] }]);
    trustWorkspace(cwd);
    const target = join(cwd, 'mcp-made.txt');
    const foreign = join(cwd, 'foreign-during-mcp.txt');
    const changes = await drive([block('mcp__w__write_probe', { path: target, text: 'from-mcp\n' }), 'Done.'], {
      requestApproval: (() => {
        writeFileSync(foreign, 'typed while the MCP prompt was open\n');
        return Promise.resolve({ approved: true });
      }) as RequestApproval,
    });
    expect(changes.some((c) => c.path === target), "the MCP tool's own write must be journaled").toBe(true);
    expect(changes.some((c) => c.path === foreign), 'the foreign write must not be').toBe(false);
  });

  test('a temp file created AND removed inside the window produces no record', async () => {
    writeFileSync(join(cwd, 'src.txt'), 'aaa\n');
    const script = join(scriptDir, 'temp.js');
    writeFileSync(
      script,
      `const fs=require('fs'),p=require('path'),d=${JSON.stringify(cwd)};
       fs.writeFileSync(p.join(d,'t.tmp'),'tmp\\n');
       fs.writeFileSync(p.join(d,'src.txt'),'bbb\\n');
       fs.rmSync(p.join(d,'t.tmp'));\n`,
      'utf8',
    );
    const changes = await drive(
      [block('run_command', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }), 'Done.'],
      {},
    );
    expect(changes.some((c) => c.path === join(cwd, 't.tmp'))).toBe(false);
    expect(changes.some((c) => c.path === join(cwd, 'src.txt'))).toBe(true);
  });

  test('--no-observe still skips the opaque set, and file tools still journal', async () => {
    const script = join(scriptDir, 'off.js');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(join(cwd, 'shell-made.txt'))}, 'x\\n');\n`, 'utf8');
    const changes = await drive(
      [
        block('run_command', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }),
        block('write_file', { path: 'tool-made.txt', content: 'y\n' }),
        'Done.',
      ],
      { observeWorkspace: false },
    );
    expect(existsSync(join(cwd, 'shell-made.txt')), 'the command really ran').toBe(true);
    expect(changes.some((c) => c.path === join(cwd, 'shell-made.txt')), 'opaque writes are not journaled with observation off').toBe(false);
    expect(changes.some((c) => c.path === join(cwd, 'tool-made.txt')), 'the file tool still journals its own write').toBe(true);
  });
});

// ===========================================================================
// 3. THE RECORDER — C-UX45, counted rather than timed.
// ===========================================================================
describe('C-UX45 · the run recorder writes the journal ONCE per batch, not once per record', () => {
  /**
   * ⭐ THIS COUNTS `renameSync` CALLS, NOT MILLISECONDS. `persist()` commits the
   * journal with a temp-file rename, exactly once per persist, so the count is the
   * number of times the whole journal was re-serialised and rewritten. A timing
   * assertion would be a flake on a loaded CI runner and would also pass a fix
   * that merely got faster without getting cheaper.
   *
   * ⭐ WHAT THIS PIN STRUCTURALLY CANNOT CATCH, stated with it: it counts journal
   * COMMITS, not CPU. A change that keeps one commit per batch but makes each
   * commit quadratic in some other dimension is invisible here. The growth ceiling
   * below is the companion that bounds the other axis.
   */
  test('⭐ one opaque call changing K files commits the journal ONCE', async () => {
    const K = 60;
    const script = join(scriptDir, 'bulk.js');
    writeFileSync(
      script,
      `const fs=require('fs'),p=require('path'),d=${JSON.stringify(cwd)};
       for(let i=0;i<${K};i++) fs.writeFileSync(p.join(d,'b'+i+'.txt'),'bulk '+i+'\\n');\n`,
      'utf8',
    );
    const recorder = createRunRecorder({ cwd, task: 'bulk', initial: RESUME0 });
    const before = renames.length;
    await runAgent({
      task: 'bulk',
      cwd,
      provider: new StubProvider([
        block('run_command', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }),
        'Done.',
      ]),
      requestApproval: (() => Promise.resolve({ approved: true })) as RequestApproval,
      // ⭐ `SPY-416` — the observer is opt-in since R-CLI-1; this pin exercises it.
      observeWorkspace: true,
      recordChange: (c: RecordedChange) => recorder.recordChange(c),
      recordChanges: (cs: readonly RecordedChange[]) => recorder.recordChanges(cs),
    });
    const commits = renames.length - before;
    expect(recorder.changeCount(), 'the K writes must really have been journaled').toBe(K);
    expect(commits, `K=${K} records discovered by one window must cost ONE journal commit`).toBe(1);
  });

  /**
   * ⭐ THE FLOOR THAT BINDS THIS PIN TO ITS SUBJECT. Without it, a fix that
   * journaled NOTHING would also commit once — a green over an empty set.
   */
  test('CONTROL — the per-record path still commits per record', () => {
    const recorder = createRunRecorder({ cwd, task: 'per-record', initial: RESUME0 });
    const before = renames.length;
    for (let i = 0; i < 5; i += 1) {
      recorder.recordChange({ path: join(cwd, `p${i}.txt`), op: 'create', before: null, after: 'x' });
    }
    expect(renames.length - before, 'the single-record entry point is unchanged').toBe(5);
  });

  /**
   * ⭐ THE ARTEFACT MUST BE IDENTICAL. A cheaper writer that writes a DIFFERENT
   * journal is not a cost fix, it is a format change — and `planRewind`, `resume`
   * and `spycore rewind` all read this file.
   */
  test('⭐ the batched journal is byte-identical to the per-record one', () => {
    const recs: RecordedChange[] = Array.from({ length: 12 }, (_v, i) => ({
      path: join(cwd, `j${i}.txt`),
      op: 'create' as const,
      before: null,
      after: `content ${i}\n`,
    }));
    const a = createRunRecorder({ cwd, task: 'same', initial: RESUME0 });
    for (const r of recs) a.recordChange(r);
    const b = createRunRecorder({ cwd, task: 'same', initial: RESUME0 });
    b.recordChanges(recs);
    expect(b.changes()).toEqual(a.changes());
    expect(b.changeCount()).toBe(a.changeCount());
  });

  /**
   * ⭐ THE COMPLETENESS LEG — the one a PLANT catches.
   *
   * A new `runAgent` call site that wires `recordChange` and forgets
   * `recordChanges` still journals correctly and still passes every cell above; it
   * just silently pays the quadratic again. That is precisely the shape M8 caught
   * last batch — a real addition with no corpus cell. So the wiring is asserted
   * mechanically over the package's own source, not trusted to review.
   */
  test('⭐ every runAgent call site that wires recordChange also wires recordChanges', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e)) files.push(full);
      }
    };
    walk(root);

    /**
     * ⭐ THE SCAN IS OVER `runAgent(` CALL SITES, NOT OVER A WIRING IDIOM. The
     * first version matched `recordChange: (c) => X.recordChange(c)` and found
     * three sites — missing `AgentApp.tsx`, whose sink is a block body, which is a
     * real `runAgent` caller with a real recorder. A completeness leg blind to one
     * member of the population it exists to close is not a completeness leg.
     */
    const sites: Array<{ file: string; records: boolean; batches: boolean }> = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\brunAgent\(\{/g)) {
        // The options object literal, taken by brace balance from the `{`.
        const open = (m.index as number) + m[0].length - 1;
        let depth = 0;
        let end = open;
        for (let i = open; i < src.length; i += 1) {
          const ch = src[i];
          if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const body = src.slice(open, end + 1);
        sites.push({
          file: f.slice(root.length + 1),
          records: /(^|[^\w])recordChange\s*:/.test(body),
          batches: /(^|[^\w])recordChanges\s*:/.test(body),
        });
      }
    }

    expect(sites.length, 'the scan must find the runAgent call sites — zero would make this vacuous').toBeGreaterThanOrEqual(4);
    // ⭐ And it must find BOTH kinds, or the discrimination is untested: at least
    // one site records (so `batches` is meaningful) and at least one does not.
    expect(sites.some((s) => s.records), 'at least one site must wire a recorder').toBe(true);
    expect(sites.some((s) => !s.records), 'and at least one must not — ACP has no journal').toBe(true);

    const offenders = sites.filter((s) => s.records && !s.batches).map((s) => s.file);
    expect(offenders, 'a runAgent site wiring only recordChange pays the quadratic silently').toEqual([]);
  });
});

// ===========================================================================
// 4. THE CEILING — what bounds the cost, stated as an assertion.
// ===========================================================================
describe('the observer\'s cost has a stated ceiling', () => {
  /**
   * ⭐ C-UX47's bound. The window's cost is linear in the enumerated file count
   * and that count is capped; beyond the cap no snapshot is taken at all and the
   * call is REPORTED as unjournaled rather than silently observed. These are the
   * two numbers the ceiling rests on, so they are asserted rather than described.
   */
  test('DELTA_MAX_FILES caps the window, and over the cap the run says so', () => {
    expect(DELTA_MAX_FILES).toBe(20_000);
  });

  /**
   * ⭐⭐ AND THE RECORDER'S CEILING IS THE ONE THAT USED TO BE ABSENT. The window's
   * cap bounds M (files enumerated). Nothing bounded N (records journaled), and the
   * two are joined: one window may hand the recorder up to DELTA_MAX_FILES records.
   * With the batch entry point that costs ONE commit; per record it cost N, so the
   * journal was rewritten N times — measured at the predecessor commit as 300
   * records ⇒ 303 ms and 185 MB rewritten, extrapolating to 819 GB at the cap.
   */
  test('⭐ N records from one window cost commits linear in the number of windows, not in N', () => {
    const recorder = createRunRecorder({ cwd, task: 'ceiling', initial: RESUME0 });
    const before = renames.length;
    for (const windowSize of [50, 200, 400]) {
      recorder.recordChanges(
        Array.from({ length: windowSize }, (_v, i) => ({
          path: join(cwd, `w${windowSize}-${i}.txt`),
          op: 'create' as const,
          before: null,
          after: 'x'.repeat(64),
        })),
      );
    }
    expect(recorder.changeCount()).toBe(650);
    expect(renames.length - before, 'three windows ⇒ three commits, whatever N is').toBe(3);
  });
});
