/**
 * THE display sanitizer — the single module through which every
 * model/file/MCP/registry-controlled string passes before it reaches the
 * terminal (Ink and plain paths alike).
 *
 * Threat: ANSI/control-sequence injection. A hostile string in model
 * narration, a file echoed into a diff, an MCP tool result, or even a
 * poisoned update-check response could otherwise: retitle the window or write
 * the clipboard (OSC 0/52), restyle or overwrite previously-rendered lines
 * (CSI cursor moves + \r tricks) to FAKE an approval prompt, or hide bytes
 * (SOS/APC). The defence is mechanical: at display boundaries we
 *   1. strip well-formed ESC-introduced sequences (CSI, OSC, DCS, SOS, PM,
 *      APC, and two-byte ESC escapes) entirely;
 *   2. replace any surviving ESC with a visible ␛ (U+241B);
 *   3. strip C1 controls (U+0080–U+009F — the single-byte CSI/OSC forms);
 *   4. make lone \r visible as ␍ (U+240D) so it cannot rewrite a line
 *      (\r\n is normalised to \n first);
 *   5. map remaining C0 controls (except \n and \t, which are preserved) to
 *      their Unicode control pictures (U+2400 + code).
 *
 * DISPLAY-ONLY by contract: never applied to bytes bound for the model, the
 * server, files, or --json output (JSON.stringify already escapes C0 per the
 * JSON spec, which keeps machine output terminal-safe when parsed properly).
 */

// Well-formed ESC-introduced sequences, longest-match first:
//  - CSI:  ESC [ params intermediates final
//  - OSC:  ESC ] ... terminated by BEL or ST (ESC \) — clipboard/title vector
//  - DCS/SOS/PM/APC: ESC P/X/^/_ ... terminated by ST
//  - two-byte escapes: ESC @ … ESC _ (charset switches, keypad modes, …)
const ESC_SEQUENCES =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g;

// C1 control block — the single-byte equivalents of CSI (U+009B), OSC
// (U+009D), DCS (U+0090), … Stripped outright: they are never legitimate in
// agent/file text and some terminals honor them like their ESC forms.
// eslint-disable-next-line no-control-regex
const C1_CONTROLS = /[\u0080-\u009f]/g;

// Remaining C0 controls except \t (0x09) and \n (0x0a). \r is handled
// separately so \r\n can collapse to a plain newline first.
// eslint-disable-next-line no-control-regex
const C0_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** U+2400 control pictures for the C0 range; DEL gets U+2421. */
function controlPicture(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code === 0x7f) return '␡'; // ␡
  return String.fromCharCode(0x2400 + code);
}

/**
 * Sanitize one untrusted string for terminal display. Preserves \n and \t;
 * everything else that could drive the terminal is stripped or made visible.
 * Idempotent. Never throws; non-strings come back as ''.
 */
export function sanitizeForDisplay(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
  let out = text;
  // Strip whole escape sequences BEFORE the lone-ESC fallback so an OSC body
  // (which may contain printable payloads) disappears with its introducer.
  out = out.replace(ESC_SEQUENCES, '');
  // Any ESC still standing introduces a malformed/truncated sequence — make
  // it visible instead of letting the terminal interpret what follows.
  out = out.replace(/\x1b/g, '␛'); // eslint-disable-line no-control-regex
  out = out.replace(C1_CONTROLS, '');
  // CRLF → LF (legitimate Windows line endings render fine), then any lone
  // \r becomes visible — a bare \r is the classic overwrite-the-line trick.
  out = out.replace(/\r\n/g, '\n');
  out = out.replace(/\r/g, '␍');
  out = out.replace(C0_CONTROLS, controlPicture);
  return out;
}
