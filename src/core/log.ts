/** Ring buffer of the last log lines; replaces the VS Code output channel. Shown by the `showLog` message. */
const MAX_LINES = 500;
let lines: string[] = [];

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function log(message: string): void {
  const ts = stamp();
  for (const line of message.split(/\r?\n/)) {
    lines.push(`[${ts}] ${line}`);
  }
  if (lines.length > MAX_LINES) {
    lines = lines.slice(lines.length - MAX_LINES);
  }
}

export function getLog(): string[] {
  return [...lines];
}

export function clearLog(): void {
  lines = [];
}
