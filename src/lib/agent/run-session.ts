/**
 * Session bring-up for `runAgent`: the MCP bridge and its notice, the
 * conversation (opened fresh or continued), the tool-call protocol, the
 * run-state hook, and the native tool declarations.
 *
 * Imports from loop.ts are type-only. The session is opened once per
 * `runAgent` call, after the dispatcher exists: the bridge's tools are
 * assigned to the shared tool context here, and the dispatcher reads them
 * from that context at call time.
 */
import type { AgentEvent, RunAgentOptions } from './loop.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import type { Provider } from '../providers/types.js';
import { setupMcpBridge, type McpBridge } from './mcp.js';
import { buildToolDeclarations, type ToolContext } from './tools.js';

/** Opens one run's session: MCP bridge, conversation, protocol, run-state hook, declarations. */
export async function openRunSession({
  opts,
  ctx,
  emit,
  provider,
  model,
  apiUrlOverride,
  webEnabled,
  delegateEnabled,
}: {
  opts: RunAgentOptions;
  ctx: ToolContext;
  emit: (e: AgentEvent) => void;
  provider: Provider;
  model: string;
  apiUrlOverride: RunAgentOptions['apiUrlOverride'];
  webEnabled: boolean;
  delegateEnabled: boolean;
}) {
  // MCP bridge: spawn + initialize every ENABLED server, register their tools as
  // `mcp__<server>__<tool>` in ctx.extraTools, and surface a catalog for the
  // prompt. Skipped in plan mode (MCP tools are mutating ⇒ blocked there anyway)
  // and a no-op when zero servers are configured - so the prompt stays
  // byte-identical to an MCP-free build. Per-server start failures degrade to a
  // dim warning; the run continues with the built-ins.
  const mcpBridge: McpBridge | null = opts.planMode
    ? null
    : await setupMcpBridge({
        cwd: opts.cwd,
        signal: opts.signal,
        requestApproval: opts.requestApproval,
        callTimeoutMs: opts.commandTimeoutMs,
        onWarn: (text) => emit({ type: 'mcp_notice', level: 'warn', text }),
        ...(opts.confirmProjectMcpTrust ? { confirmProjectMcpTrust: opts.confirmProjectMcpTrust } : {}),
      });
  if (mcpBridge) {
    ctx.extraTools = mcpBridge.tools;
    if (mcpBridge.toolCount > 0) {
      emit({
        type: 'mcp_notice',
        level: 'info',
        text: `${mcpBridge.toolCount} MCP tool${mcpBridge.toolCount === 1 ? '' : 's'} from ${mcpBridge.serverCount} server${mcpBridge.serverCount === 1 ? '' : 's'}`,
      });
    }
  }
  const mcpSection = mcpBridge?.promptSection ?? '';

  // Continue an existing conversation (verify fix-up) or open a fresh one.
  // The provider owns session creation: SpyCore opens a server-side
  // conversation; a BYOK provider mints a local handle for its client-side
  // history. Continuations reuse the same handle (and the same provider
  // instance), so BYOK history survives a verify fix-up.
  const conversationId =
    opts.conversationId ?? (await provider.createConversation({ model, apiUrlOverride }));

  // Tool-call protocol: NATIVE when the SpyCore server advertised it and the
  // user didn't force fenced; FENCED otherwise (old server, BYOK provider, or
  // --tool-protocol fenced). 'native' is a hard requirement - error (after
  // tearing down the bridge) rather than silently degrade. Capability was
  // captured at createConversation; continuations read the same stashed value.
  const toolProtocol = opts.toolProtocol ?? 'auto';
  const serverNativeCapable =
    provider.id === 'spycore' && (provider.supportsNativeTools?.(conversationId) ?? false);
  if (toolProtocol === 'native' && !serverNativeCapable) {
    await mcpBridge?.shutdown();
    throw new SpycoreCliError(
      'Native tool-use is not available for this run.',
      EXIT_USER_ERROR,
      provider.id !== 'spycore'
        ? 'BYOK providers use the fenced protocol - omit --tool-protocol.'
        : 'The server did not advertise native tool-use (older deployment). Omit --tool-protocol, or pass --tool-protocol fenced.',
    );
  }
  const nativeMode = toolProtocol === 'fenced' ? false : serverNativeCapable;
  // Step-boundary hook: report the bound conversation + protocol immediately,
  // then each completed turn (fired at the top of the NEXT turn). Isolated so
  // a hook failure can never break the run.
  const fireRunState = (turnsCompleted: number): void => {
    if (!opts.onRunState) return;
    try {
      opts.onRunState({ conversationId, nativeTools: nativeMode, turnsCompleted });
    } catch {
      /* the hook is best-effort */
    }
  };
  fireRunState(0);
  // Tool declarations for native mode: read-only subset in the plan phase, the
  // full set (built-ins + MCP) in execute. Recomputed per runAgent call, so the
  // plan and execute phases declare their correct sets.
  const toolDecls = nativeMode
    ? buildToolDeclarations({
        readOnlyOnly: opts.planMode === true,
        extraTools: ctx.extraTools,
        webEnabled,
        delegateEnabled,
      })
    : undefined;

  return { mcpBridge, mcpSection, conversationId, nativeMode, toolDecls, fireRunState };
}
