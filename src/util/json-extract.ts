// src/util/json-extract.ts
//
// Pulling a JSON object out of a model reply: strip a ```json fence, then take the first
// balanced object. Shared by the escalation judge, the judge brief and outreach matching,
// which with the dispatcher's outreach-link block also shares encodeUntrustedJson.
//
// Intentionally not shared with src/dispatch/outbound-judge.ts, which keeps its own copy:
// that security boundary stays independent so a change here cannot silently weaken it.

/**
 * JSON-encode untrusted text for a prompt or a context block: quotes and newlines are
 * escaped, and angle brackets too, so the text cannot close a sentinel tag or add lines.
 */
export function encodeUntrustedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1]!.trim() : trimmed;
}

/**
 * Return the first balanced top-level JSON object substring in `text`, or null.
 * Tracks string literals and escape sequences so braces inside strings don't
 * affect the nesting depth.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
