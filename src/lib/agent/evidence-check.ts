/**
 * A-9 - evidence check at close: match the final answer's claims against the
 * run's ACTUAL tool calls.
 *
 * A model that writes "tests passed" without running any test is the
 * cheapest hallucination to catch: the claim is checked against the tool
 * calls the run really made. WARN ONLY, never block - the final answer is
 * emitted unchanged; the warning goes to the event stream so the user (and
 * the transcript) sees the mismatch.
 */
export interface EvidenceCall {
  tool: string;
  ok: boolean;
  /** run_command's command string, when the call was one. */
  command?: string | undefined;
}

interface ClaimRule {
  /** Matches the claim in the final answer. */
  claim: RegExp;
  /** What the claim is called in the warning. */
  name: string;
  /** True when a tool call backs the claim. */
  satisfiedBy: (call: EvidenceCall) => boolean;
}

const TEST_COMMAND_RE = /\b(test|jest|vitest|pytest|phpunit|rspec|go test|cargo test|npm test|pnpm test|bun test|yarn test|make test|ctest)\b/i;
const BUILD_COMMAND_RE = /\b(build|tsc\b|vite build|webpack|esbuild|go build|cargo build|make\b.*\bbuild|gradle build)\b/i;
const LINT_COMMAND_RE = /\b(lint|eslint|ruff|flake8|clippy|gofmt|prettier --check)\b/i;

function runCommandMatching(call: EvidenceCall, re: RegExp): boolean {
  return call.tool === 'run_command' && call.ok && re.test(call.command ?? '');
}

/**
 * A successful `delegate` call backs any claim: the child run is opaque to
 * this check - its tool calls are not in this run's evidence - so warning
 * whenever the tests ran inside a child would be a false positive by
 * construction. The check is warn-only; unknowable evidence must not warn.
 */
function delegateBacking(call: EvidenceCall): boolean {
  return call.tool === 'delegate' && call.ok;
}

/**
 * An MCP tool call whose tool segment names the work (`mcp__<server>__<tool>`):
 * `run_tests`, `build`, `lint` and their compounds back the matching claim.
 * Only the tool NAME is visible here (no args), so this matches on whole
 * `_`/`-`-separated segments of the tool segment - `run_tests` backs the
 * test claim, `testify` does not. The command regexes above cannot do this:
 * their `\b` never fires inside a snake_case name.
 */
const MCP_TEST_TOOLS = new Set(['test', 'tests', 'jest', 'vitest', 'pytest', 'phpunit', 'rspec', 'ctest']);
const MCP_BUILD_TOOLS = new Set(['build', 'tsc', 'vite', 'webpack', 'esbuild', 'gradle']);
const MCP_LINT_TOOLS = new Set(['lint', 'eslint', 'ruff', 'flake8', 'clippy', 'gofmt', 'prettier']);

function mcpToolMatching(call: EvidenceCall, tools: ReadonlySet<string>): boolean {
  if (!call.ok || !call.tool.startsWith('mcp__')) return false;
  const toolPart = call.tool.slice(call.tool.lastIndexOf('__') + 2);
  return toolPart
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((seg) => tools.has(seg));
}

const CLAIM_RULES: ClaimRule[] = [
  {
    claim: /\btests?\s+(passed|succeeded|successful|are passing|all green)\b/i,
    name: 'tests passed',
    satisfiedBy: (c) =>
      runCommandMatching(c, TEST_COMMAND_RE) || delegateBacking(c) || mcpToolMatching(c, MCP_TEST_TOOLS),
  },
  {
    claim: /\bbuild\s+(passed|succeeded|successful)\b/i,
    name: 'build succeeded',
    satisfiedBy: (c) =>
      runCommandMatching(c, BUILD_COMMAND_RE) || delegateBacking(c) || mcpToolMatching(c, MCP_BUILD_TOOLS),
  },
  {
    claim: /\blint\s+(passed|clean|succeeded)\b/i,
    name: 'lint passed',
    satisfiedBy: (c) =>
      runCommandMatching(c, LINT_COMMAND_RE) || delegateBacking(c) || mcpToolMatching(c, MCP_LINT_TOOLS),
  },
];

/**
 * Check `finalText` for evidence-backed claims. Returns one warning per
 * unbacked claim; empty when every claim the rules recognise has a matching
 * successful tool call (or the text makes no such claim).
 */
export function checkEvidenceClaims(finalText: string, calls: EvidenceCall[]): string[] {
  const warnings: string[] = [];
  for (const rule of CLAIM_RULES) {
    if (!rule.claim.test(finalText)) continue;
    if (calls.some(rule.satisfiedBy)) continue;
    warnings.push(
      `The final answer claims "${rule.name}", but no matching successful tool call was made this run. ` +
        'Verify the claim before relying on it.',
    );
  }
  return warnings;
}
