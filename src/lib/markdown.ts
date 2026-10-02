import { Chalk } from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';

/**
 * Streaming-aware terminal markdown renderer.
 *
 * The web client renders markdown after the full message arrives. The CLI
 * has to render *while* tokens stream in, which means we have to handle
 * partial syntax: a "**fo" half-bold could be completed in the next chunk
 * (-> "**foo**") or could be literal text. We solve this by buffering the
 * trailing fragment of every chunk that *might* still be inside a markup
 * span; flush() empties the buffer so callers don't leak state.
 *
 * This is a deliberately small implementation — full CommonMark would be
 * overkill for streaming chat output and would inflate the bundle. We
 * cover the markup the assistant actually emits: headings, bold/italic,
 * code spans + fenced code blocks, lists, blockquotes, hr, and links.
 */
export interface MarkdownRenderer {
  /** Feed one chunk of markdown source; returns the rendered slice ready to print. */
  write(chunk: string): string;
  /** Flush remaining buffered content. Call this after the stream ends. */
  flush(): string;
}

export interface MarkdownRendererOptions {
  /** Disable ANSI escape codes (use this when stdout is not a TTY or --no-color). */
  color: boolean;
  /** Optional terminal width for soft-wrapping prose lines. Code blocks never wrap. */
  wrapWidth?: number | undefined;
}

/**
 * Rendering state machine. We process source line-by-line because most
 * markdown semantics live at the line level (headings, list bullets, hr,
 * fenced code). Within a line we apply inline rules (bold, italic, code
 * spans, links) but only when we're not currently inside a fenced code
 * block.
 */
export function createMarkdownRenderer(
  opts: MarkdownRendererOptions,
): MarkdownRenderer {
  let buffer = '';
  let inCodeFence = false;
  let codeFenceLang = '';
  let codeFenceBuffer = '';

  // Use a local Chalk instance with an explicit level so the renderer's
  // colour decision is independent of the global chalk and the host
  // TTY detection. Level 1 covers the basic 16 colours every terminal
  // supports without gambling on truecolor.
  const chalk = new Chalk({ level: opts.color ? 1 : 0 });
  const colorize = (s: string, fn: (input: string) => string) =>
    opts.color ? fn(s) : s;

  const renderInline = (line: string): string => {
    // Code spans first so the contents aren't accidentally double-styled.
    let out = line.replace(/`([^`\n]+)`/g, (_m, code: string) =>
      colorize(code, (s) => chalk.dim.bgBlackBright(` ${s} `)),
    );
    out = out.replace(
      /\*\*([^*\n]+)\*\*/g,
      (_m, t: string) => colorize(t, (s) => chalk.bold(s)),
    );
    out = out.replace(
      /(^|[^*])\*([^*\n]+)\*/g,
      (_m, lead: string, t: string) =>
        `${lead}${colorize(t, (s) => chalk.italic(s))}`,
    );
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, label: string, url: string) =>
        `${colorize(label, (s) => chalk.cyan.underline(s))} ${colorize(`(${url})`, (s) => chalk.dim(s))}`,
    );
    return out;
  };

  const renderLine = (line: string): string => {
    if (line.startsWith('### ')) {
      return colorize(line.slice(4), (s) => chalk.bold.cyan(s)) + '\n';
    }
    if (line.startsWith('## ')) {
      return colorize(line.slice(3), (s) => chalk.bold.magenta(s)) + '\n';
    }
    if (line.startsWith('# ')) {
      return colorize(line.slice(2), (s) => chalk.bold.yellow(s)) + '\n';
    }
    if (/^---+$/.test(line.trim())) {
      const w = opts.wrapWidth ?? 60;
      return colorize('─'.repeat(Math.max(10, Math.min(w, 80))), (s) => chalk.dim(s)) + '\n';
    }
    if (line.startsWith('> ')) {
      return colorize(`│ ${line.slice(2)}`, (s) => chalk.gray(s)) + '\n';
    }
    const olMatch = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (olMatch) {
      const [, indent, num, rest] = olMatch;
      return `${indent}${colorize(`${num}.`, (s) => chalk.cyan(s))} ${renderInline(rest ?? '')}\n`;
    }
    const ulMatch = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (ulMatch) {
      const [, indent, rest] = ulMatch;
      return `${indent}${colorize('•', (s) => chalk.cyan(s))} ${renderInline(rest ?? '')}\n`;
    }
    return renderInline(line) + '\n';
  };

  const renderCodeBlock = (lang: string, code: string): string => {
    let body = code;
    if (opts.color) {
      // Only invoke highlight.js for a language it actually knows. An
      // unregistered or pseudo-language (e.g. "spycore:tool", or anything with
      // a colon) makes it log "Could not find the language …" and throw; the
      // throw is caught, but the log would still flood. No lang → auto-detect.
      const lc = lang.trim();
      const canHighlight = !lc || (!lc.includes(':') && supportsLanguage(lc));
      if (canHighlight) {
        try {
          body = highlight(code, { language: lc || undefined, ignoreIllegals: true });
        } catch {
          body = code;
        }
      }
    }
    if (!opts.color) return body + '\n';
    const lines = body.split('\n');
    return lines.map((l) => chalk.dim('│ ') + l).join('\n') + '\n';
  };

  const consumeCompleteLines = (text: string): { complete: string; remainder: string } => {
    const idx = text.lastIndexOf('\n');
    if (idx === -1) return { complete: '', remainder: text };
    return { complete: text.slice(0, idx + 1), remainder: text.slice(idx + 1) };
  };

  return {
    write(chunk: string): string {
      buffer += chunk;
      const { complete, remainder } = consumeCompleteLines(buffer);
      buffer = remainder;

      if (complete.length === 0) return '';

      let out = '';
      const lines = complete.split('\n');
      // The trailing element is the empty string after the final \n; drop it.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

      for (const line of lines) {
        const fenceMatch = /^```(\S*)\s*$/.exec(line);
        if (fenceMatch) {
          if (!inCodeFence) {
            inCodeFence = true;
            codeFenceLang = fenceMatch[1] ?? '';
            codeFenceBuffer = '';
            out += colorize(`╭─ ${codeFenceLang || 'code'} ─`, (s) => chalk.dim(s)) + '\n';
            continue;
          }
          // Closing fence — flush.
          out += renderCodeBlock(codeFenceLang, codeFenceBuffer.replace(/\n$/, ''));
          out += colorize(`╰─`, (s) => chalk.dim(s)) + '\n';
          inCodeFence = false;
          codeFenceLang = '';
          codeFenceBuffer = '';
          continue;
        }
        if (inCodeFence) {
          codeFenceBuffer += line + '\n';
          continue;
        }
        out += renderLine(line);
      }
      return out;
    },

    flush(): string {
      let out = '';
      if (buffer.length > 0) {
        if (inCodeFence) {
          codeFenceBuffer += buffer;
        } else {
          out += renderInline(buffer);
        }
        buffer = '';
      }
      if (inCodeFence) {
        out += renderCodeBlock(codeFenceLang, codeFenceBuffer.replace(/\n$/, ''));
        out += colorize(`╰─`, (s) => chalk.dim(s)) + '\n';
        inCodeFence = false;
        codeFenceLang = '';
        codeFenceBuffer = '';
      }
      return out;
    },
  };
}
