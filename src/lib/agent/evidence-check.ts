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

const CLAIM_RULES: ClaimRule[] = [
  {
    claim: /\btests?\s+(passed|succeeded|successful|are passing|all green)\b/i,
    name: 'tests passed',
    satisfiedBy: (c) => runCommandMatching(c, TEST_COMMAND_RE),
  },
  {
    claim: /\bbuild\s+(passed|succeeded|successful)\b/i,
    name: 'build succeeded',
    satisfiedBy: (c) => runCommandMatching(c, BUILD_COMMAND_RE),
  },
  {
    claim: /\blint\s+(passed|clean|succeeded)\b/i,
    name: 'lint passed',
    satisfiedBy: (c) => runCommandMatching(c, LINT_COMMAND_RE),
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
