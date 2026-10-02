/**
 * Output format presets — text, json, markdown, yaml.
 *
 * Used by commands that already support `--json` and want to add `--format`
 * for richer output. The preset matrix:
 *
 *   text     — human-friendly default (caller renders)
 *   json     — JSON.stringify with 2-space indent
 *   markdown — array-of-objects → table; primitives → fenced code
 *   yaml     — minimal hand-rolled emitter (no dep). Handles strings,
 *              numbers, booleans, null, arrays, and nested objects. Long /
 *              multiline strings are emitted as block-literal scalars.
 *
 * Authoring rule: if you reach for a feature this doesn't support (anchors,
 * tags, complex keys), it's almost certainly the wrong place to add it —
 * `--format json` already covers the machine-consumption case.
 */

export const OUTPUT_FORMATS = ['text', 'json', 'markdown', 'yaml'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function isOutputFormat(s: string): s is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(s);
}

/** Format the data using the requested preset. `text` is a passthrough. */
export function formatOutput(data: unknown, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'markdown':
      return toMarkdown(data);
    case 'yaml':
      return toYaml(data);
    case 'text':
    default:
      if (typeof data === 'string') return data;
      return JSON.stringify(data, null, 2);
  }
}

function toMarkdown(data: unknown): string {
  if (Array.isArray(data) && data.length > 0 && data.every(isPlainObject)) {
    return toMarkdownTable(data as Array<Record<string, unknown>>);
  }
  if (isPlainObject(data)) {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      lines.push(`- **${k}**: ${stringifyScalar(v)}`);
    }
    return lines.join('\n');
  }
  return '```\n' + stringifyScalar(data) + '\n```';
}

function toMarkdownTable(rows: Array<Record<string, unknown>>): string {
  const columns = collectColumns(rows);
  const header = `| ${columns.join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((row) => `| ${columns.map((c) => mdCell(row[c])).join(' | ')} |`)
    .join('\n');
  return `${header}\n${separator}\n${body}`;
}

function collectColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
  return Array.from(seen);
}

function mdCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  // Pipe characters break markdown table cells; backslash-escape them.
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function toYaml(data: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (data === null || data === undefined) return 'null';
  if (typeof data === 'boolean') return data ? 'true' : 'false';
  if (typeof data === 'number') return Number.isFinite(data) ? String(data) : 'null';
  if (typeof data === 'string') return yamlScalar(data);

  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    return data
      .map((item) => {
        const rendered = toYaml(item, indent + 1);
        if (isPlainObject(item) || Array.isArray(item)) {
          // Hoist first line onto the dash; indent the rest.
          const lines = rendered.split('\n');
          const first = lines[0]?.replace(/^ +/, '') ?? '';
          const rest = lines.slice(1).join('\n');
          return rest
            ? `${pad}- ${first}\n${rest}`
            : `${pad}- ${first}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join('\n');
  }

  if (isPlainObject(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        if (isPlainObject(v) || Array.isArray(v)) {
          const inner = toYaml(v, indent + 1);
          if (inner === '{}' || inner === '[]') {
            return `${pad}${yamlKey(k)}: ${inner}`;
          }
          return `${pad}${yamlKey(k)}:\n${inner}`;
        }
        return `${pad}${yamlKey(k)}: ${toYaml(v, indent + 1)}`;
      })
      .join('\n');
  }

  return JSON.stringify(data);
}

function yamlKey(k: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(k)) return k;
  return JSON.stringify(k);
}

function yamlScalar(s: string): string {
  // Multiline → block literal, preserves newlines.
  if (s.includes('\n')) {
    return '|-\n' + s.split('\n').map((line) => `  ${line}`).join('\n');
  }
  // Strings that look like other types or contain special chars get quoted.
  if (
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^-?\d/.test(s) ||
    /^[!&*?{}\[\]|>%@`,]|^[ \t]|[ \t]$/.test(s) ||
    s.includes(': ') ||
    s.includes('#') ||
    s.includes('"') ||
    s.includes("'")
  ) {
    return JSON.stringify(s);
  }
  return s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringifyScalar(v: unknown): string {
  if (v === null || v === undefined) return '_(none)_';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
