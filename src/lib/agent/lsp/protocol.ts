/**
 * LSP wire framing, implemented from scratch.
 *
 * Unlike MCP's newline-delimited JSON-RPC, LSP frames every message as
 *
 *   Content-Length: <bytes>\r\n\r\n<body>
 *
 * where the length counts UTF-8 BYTES of the body — not characters. Getting
 * this wrong (e.g. using `string.length` on multibyte output) silently
 * truncates or stalls the stream, so the framer works on Buffers throughout
 * and only decodes complete bodies.
 *
 * Pure and process-free: feed() takes byte chunks and returns complete
 * message bodies. Malformed input fails closed with LspError rather than
 * accumulating unbounded state.
 */
import { LspError } from './types.js';

/** Hard ceiling on one LSP message body (fail closed, like the MCP client). */
export const LSP_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Cap on the header block before its terminator — a server that streams
 *  headerless bytes is broken; don't buffer it forever. */
const MAX_HEADER_BYTES = 8 * 1024;

const CONTENT_LENGTH_RE = /^content-length\s*:\s*(\d+)\s*$/im;

export class LspFramer {
  private buf: Buffer = Buffer.alloc(0);

  /**
   * Feed a chunk; returns every complete message BODY (still JSON text)
   * that the chunk completed, in order. Throws LspError on malformed or
   * oversized input.
   */
  feed(chunk: Buffer | string): string[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes]);
    const out: string[] = [];
    for (;;) {
      const headerEnd = findHeaderEnd(this.buf);
      if (headerEnd === -1) {
        if (this.buf.length > MAX_HEADER_BYTES) {
          throw new LspError(
            `LSP header block exceeded ${MAX_HEADER_BYTES} bytes without a terminator; closing the connection`,
          );
        }
        return out;
      }
      const headerText = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = CONTENT_LENGTH_RE.exec(headerText);
      const length = m ? parseInt(m[1] as string, 10) : NaN;
      if (!Number.isInteger(length) || length < 0) {
        throw new LspError('LSP message without a valid Content-Length header');
      }
      if (length > LSP_MAX_MESSAGE_BYTES) {
        throw new LspError(
          `LSP message of ${length} bytes exceeds the ${LSP_MAX_MESSAGE_BYTES}-byte cap; closing the connection`,
        );
      }
      const bodyStart = headerEnd + headerTerminatorLength(this.buf, headerEnd);
      if (this.buf.length < bodyStart + length) return out; // need more bytes
      out.push(this.buf.subarray(bodyStart, bodyStart + length).toString('utf8'));
      this.buf = this.buf.subarray(bodyStart + length);
      if (this.buf.length === 0) return out;
    }
  }

  /** Bytes still buffered (a partial message). Exposed for tests. */
  get bufferedBytes(): number {
    return this.buf.length;
  }
}

/** Locate the header terminator: `\r\n\r\n` per spec, lone `\n\n` tolerated. */
function findHeaderEnd(buf: Buffer): number {
  const crlf = buf.indexOf('\r\n\r\n');
  if (crlf !== -1) return crlf;
  return buf.indexOf('\n\n');
}

function headerTerminatorLength(buf: Buffer, at: number): number {
  return buf[at] === 0x0d ? 4 : 2; // '\r' → \r\n\r\n, else \n\n
}

/** Encode one JSON-RPC value as a complete LSP wire message. */
export function encodeLspMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}
