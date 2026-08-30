// Fork-only file (see FORK_NOTES.md). String-aware JSONC comment stripper for the presets
// routes. The previous `text.replace(/\/\/.*$/gm, '')` also ran on plain `.json` and cut every
// line at the first `//` — including the one inside "https://..." in a description string —
// which turned a valid preset into "Failed to read preset". This walks the text once and
// only treats `//` and `/* */` as comments when they occur outside a string literal.
// Trailing commas are left alone: JSON.parse rejects them, which is the behaviour presets
// have always had.
export const stripJsonComments = (text: string): string => {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // copy the whole string literal verbatim, honouring escapes
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        j += 1;
      }
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      // line comment: drop up to (not including) the newline so line numbers survive
      let j = i + 2;
      while (j < n && text[j] !== '\n' && text[j] !== '\r') j += 1;
      i = j;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        i = n;
        continue;
      }
      // keep the newlines inside the block so line numbers survive
      out += text.slice(i, end + 2).replace(/[^\n]/g, '');
      i = end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

export const parseJsonc = <T = unknown>(text: string): T => JSON.parse(stripJsonComments(text)) as T;
