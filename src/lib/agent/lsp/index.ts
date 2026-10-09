/**
 * LSP integration barrel: the language-server client, lifecycle manager,
 * opt-in config, wire framing, and shared types.
 */
export { LspClient, DEFAULT_LSP_INIT_TIMEOUT_MS, DEFAULT_LSP_REQUEST_TIMEOUT_MS } from './client.js';
export {
  LspManager,
  LANGUAGE_SPECS,
  detectLanguages,
  languageForExtension,
  commandExists,
  getLspManager,
  shutdownLspManagers,
  __clearLspManagersForTests,
  type BuiltinServerSpec,
  type WorkspaceDiagnostics,
} from './manager.js';
export {
  LSP_CONFIG_REL,
  LSP_ENV_VAR,
  loadLspConfig,
  isLspEnabled,
  type LspConfig,
  type LspServerOverride,
} from './config.js';
export { LspFramer, encodeLspMessage, LSP_MAX_MESSAGE_BYTES } from './protocol.js';
export {
  LspError,
  mapLspSeverity,
  formatLspDiagnostics,
  type LspDiagnostic,
  type LspLanguageId,
  type LspRawDiagnostic,
  type LspSeverity,
  type LspServerStatus,
  type LanguageServerStatus,
} from './types.js';
