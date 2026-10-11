import { beforeEach, describe, expect, test, vi } from 'vitest';
import { COMPACT_PREVIEW_TEXT, runCompactFlow, type CompactFlowIo } from '../src/lib/slash/compact-flow.js';
import { SpycoreCliError, EXIT_SERVER_ERROR } from '../src/lib/errors.js';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', () => ({
  api: { post: vi.fn() },
}));

const post = vi.mocked(api.post);

function io(answers: string[] = ['y']): { io: CompactFlowIo; notices: [string, string][] } {
  const notices: [string, string][] = [];
  return {
    io: {
      notify: (kind, text) => {
        notices.push([kind, text]);
      },
      ask: async () => answers.shift() ?? 'n',
    },
    notices,
  };
}

beforeEach(() => {
  post.mockReset();
});

describe('runCompactFlow', () => {
  test('the preview notice states the invariant verbatim before asking', async () => {
    const { io: ioObj, notices } = io(['n']);
    const out = await runCompactFlow({ conversationId: 'c1', io: ioObj });
    expect(out).toEqual({ compacted: false });
    expect(notices[0]).toEqual(['info', COMPACT_PREVIEW_TEXT]);
    expect(notices[1]).toEqual(['info', 'Compact cancelled - nothing changed.']);
    expect(post).not.toHaveBeenCalled();
  });

  test('anything but an explicit yes cancels with ZERO server calls', async () => {
    for (const answer of ['n', 'N', '', 'maybe', 'y', 'YES']) {
      post.mockReset();
      const { io: ioObj } = io([answer]);
      const wantsYes = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
      if (wantsYes) {
        post.mockResolvedValueOnce({ summaryMessageId: 's', summary: 'x', archivedCount: 1 });
      }
      const out = await runCompactFlow({ conversationId: 'c1', io: ioObj });
      expect(out.compacted).toBe(wantsYes);
      expect(post).toHaveBeenCalledTimes(wantsYes ? 1 : 0);
    }
  });

  test('success posts to the summarize endpoint and reports archived counts', async () => {
    post.mockResolvedValue({ summaryMessageId: 's1', summary: 'Big summary', archivedCount: 42 });
    const { io: ioObj, notices } = io(['yes']);
    const out = await runCompactFlow({ conversationId: 'conv-9', io: ioObj });
    expect(out).toEqual({ compacted: true, archivedCount: 42 });
    expect(post).toHaveBeenCalledWith('/conversations/conv-9/summarize', {
      apiUrlOverride: undefined,
      body: {},
    });
    const success = notices.find(([k]) => k === 'success')!;
    expect(success[1]).toContain('42 messages archived (recoverable)');
    expect(success[1]).toContain('Summary: Big summary');
  });

  test('singular "message archived" grammar', async () => {
    post.mockResolvedValue({ summaryMessageId: 's1', summary: '', archivedCount: 1 });
    const { io: ioObj, notices } = io(['y']);
    await runCompactFlow({ conversationId: 'c1', io: ioObj });
    expect(notices.find(([k]) => k === 'success')![1]).toContain('1 message archived (recoverable)');
  });

  test('long summaries are capped in the echo', async () => {
    post.mockResolvedValue({ summaryMessageId: 's1', summary: 'x'.repeat(1000), archivedCount: 3 });
    const { io: ioObj, notices } = io(['y']);
    await runCompactFlow({ conversationId: 'c1', io: ioObj });
    const success = notices.find(([k]) => k === 'success')![1];
    const echoed = success.split('Summary: ')[1]!;
    expect(echoed.length).toBeLessThanOrEqual(281); // 280 + ellipsis
    expect(echoed.endsWith('…')).toBe(true);
  });

  test('server errors land as error notices, never throw', async () => {
    post.mockRejectedValue(new SpycoreCliError('rate limited', EXIT_SERVER_ERROR));
    const { io: ioObj, notices } = io(['y']);
    const out = await runCompactFlow({ conversationId: 'c1', io: ioObj });
    expect(out).toEqual({ compacted: false });
    expect(notices.find(([k]) => k === 'error')![1]).toBe('Compact failed: rate limited');
  });

  test('non-CLI errors are surfaced by message, not the whole object', async () => {
    post.mockRejectedValue(new Error('boom'));
    const { io: ioObj, notices } = io(['y']);
    await runCompactFlow({ conversationId: 'c1', io: ioObj });
    expect(notices.find(([k]) => k === 'error')![1]).toBe('Compact failed: boom');
  });

  test('the preview text pins the nothing-is-deleted invariant', () => {
    expect(COMPACT_PREVIEW_TEXT).toContain('Nothing is deleted');
    expect(COMPACT_PREVIEW_TEXT).toContain('archived (kept and recoverable)');
    expect(COMPACT_PREVIEW_TEXT).toContain('same id');
  });
});
