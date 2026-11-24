// site-generator-fast: a faster drop-in for makefun-site 1.0.0.
// Re-implements the reference build (front matter, template dialect, Markdown
// subset, slug rule, report) exactly, with the same observable behaviour,
// but without the reference's per-character regex work, token arrays and
// closure-per-loop-item rendering. All caches live inside one run() call:
// nothing is carried from one case to the next.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

function escapeHtml(s, cache) {
  if (s.length <= 64 && cache) {
    const hit = cache.get(s);
    if (hit !== undefined) return hit;
    if (!ESC_TEST.test(s)) {
      cache.set(s, s);
      return s;
    }
    const out = s.replace(ESC_RE, (c) => ESC[c]);
    cache.set(s, out);
    return out;
  }
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESC[c]);
}

// Escape of one character (used by the inline renderer).
function esc1(c) {
  return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : c;
}

const MARK_RE = /\p{M}/gu;

function slugifyRaw(text) {
  let plain = text;
  // NFKD + strip combining marks; ASCII-only input is already in NFKD form
  // with no marks, so skip the (expensive) normalisation there.
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  if (ascii) {
    // ASCII fast path: the per-character loop below classifies exactly the
    // same way (a-z0-9 kept, A-Z lowercased, every other run one '-'), so a
    // regex does the same work in native code. Leading/trailing runs are
    // dropped, then the 64-char cut and trailing-dash strip, as in the loop.
    let s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (s.charCodeAt(0) === 45) s = s.slice(1);
    s = s.slice(0, 64).replace(/-+$/, '');
    return s === '' ? 'untitled' : s;
  }
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

// Count runs of non-whitespace (same as /\S+/g) without building a match array.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function resolveFrom(parts0, rel) {
  const parts = parts0.slice();
  let start = 0;
  while (start <= rel.length) {
    const slash = rel.indexOf('/', start);
    const seg = slash === -1 ? rel.slice(start) : rel.slice(start, slash);
    if (seg === '' || seg === '.') {
      // skip
    } else if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
    if (slash === -1) break;
    start = slash + 1;
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 'a' && c <= 'z') || c === '_';
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // YYYY-MM-DD, real day, 1970-01-01..2099-12-31
      if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "slug": not a slug' };
      }
      // single '-' between alphanumerics: ^[a-z0-9]+(?:-[a-z0-9]+)*$
      if (raw[0] === '-' || raw[raw.length - 1] === '-' || raw.indexOf('--') !== -1) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Line helpers over a string with '\n' ends, without splitting it.
function lineAt(src, pos) {
  const j = src.indexOf('\n', pos);
  return j === -1 ? src.slice(pos) : src.slice(pos, j);
}
function nextPos(src, pos) {
  const j = src.indexOf('\n', pos);
  return j === -1 ? src.length + 1 : j + 1;
}
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function parseFrontMatter(text) {
  const first = lineAt(text, 0);
  if (first !== '---') return { error: 'no front matter' };
  // find closing '---' line
  let pos = nextPos(text, 0);
  let closePos = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const line = lineAt(text, pos);
    if (line === '---') { closePos = pos; closeEnd = nextPos(text, pos); break; }
    pos = nextPos(text, pos);
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // 1-based, opening '---' is line 1
  pos = nextPos(text, 0);
  while (pos < closePos) {
    lineNo++;
    const line = lineAt(text, pos);
    pos = nextPos(text, pos);
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue; // '#' comment
    const colon = line.indexOf(':');
    if (colon === -1) return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, colon);
    if (key.length === 0) return { error: `line ${lineNo} is not "key: value"` };
    for (let i = 0; i < key.length; i++) if (!isKeyChar(key[i])) return { error: `line ${lineNo} is not "key: value"` };
    let raw;
    if (colon + 1 === line.length) raw = '';
    else if (line[colon + 1] === ' ') raw = line.slice(colon + 2).replace(/[ \t]+$/, '');
    else return { error: `line ${lineNo} is not "key: value"` };
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd > text.length ? '' : text.slice(closeEnd);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Inline Markdown into `buf` (array of strings); callers needing a string
// join the buffer. Same output as building one string, without the
// intermediate strings at every nesting level.
function inline(s, env, buf) {
  let i = 0;
  const n = s.length;
  const re = /[\\`*\[&<>"']/g;
  while (i < n) {
    // next char that matters: a markup special (\ ` * [) or an HTML-escapable
    // (& < > " '). Text between matches needs no escaping, so it is copied
    // verbatim in one native regex scan.
    re.lastIndex = i;
    const mt = re.exec(s);
    const j = mt === null ? n : mt.index;
    if (j > i) buf.push(s.slice(i, j));
    if (j >= n) break;
    i = j;
    const c = s[i];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      buf.push(esc1(c));
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        buf.push(esc1(s[i + 1]));
        i += 2;
      } else {
        buf.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const close = s.indexOf('`', i + 1);
      if (close > i + 1) {
        buf.push('<code>', escapeHtml(s.slice(i + 1, close), null), '</code>');
        i = close + 1;
      } else {
        buf.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const close = findUnescaped(s, '**', i + 2);
        if (close > i + 2) {
          buf.push('<strong>');
          inline(s.slice(i + 2, close), env, buf);
          buf.push('</strong>');
          i = close + 2;
        } else {
          buf.push('**');
          i += 2;
        }
        continue;
      }
      const close = findSingleStar(s, i + 1);
      if (close > i + 1) {
        buf.push('<em>');
        inline(s.slice(i + 1, close), env, buf);
        buf.push('</em>');
        i = close + 1;
      } else {
        buf.push('*');
        i++;
      }
      continue;
    }
    // '['
    const closeBracket = findUnescaped(s, ']', i + 1);
    const m = closeBracket !== -1 && s[closeBracket + 1] === '(' ? s.indexOf(')', closeBracket + 2) : -1;
    const target = m === -1 ? '' : s.slice(closeBracket + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      buf.push('<a href="', escapeHtml(env.link(target), null), '">');
      inline(s.slice(i + 1, closeBracket), env, buf);
      buf.push('</a>');
      i = m + 1;
      continue;
    }
    buf.push('[');
    i++;
  }
}

function inlineStr(s, env) {
  const buf = [];
  inline(s, env, buf);
  return buf.join('');
}

// Block-level helpers (line is a plain string, no trailing '\n').

function fenceLang(line) {
  // returns the language, or null when the line is not a fence opening
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}

function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

function headingOf(line) {
  let h = 0;
  while (h < line.length && line[h] === '#') h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length || (line[h] !== ' ' && line[h] !== '\t')) return null;
  let a = h;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  if (a >= line.length) return null;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: h, text: line.slice(a, b) };
}

function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceLang(line) !== null; // '`'
  if (c0 === 35) return headingOf(line) !== null; // '#'
  if (c0 === 45 || c0 === 42) return isHr(line); // '-' or '*'
  return false;
}

function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const buf = [];
  const toc = [];
  let excerpt = null;
  let pos = 0;
  const total = src.length;
  while (pos <= total) {
    const line = lineAt(src, pos);
    if (line.length === 0 || ((line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) && isBlankLine(line))) {
      pos = nextPos(src, pos);
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      pos = nextPos(src, pos);
      while (pos <= total) {
        const l = lineAt(src, pos);
        if (isFenceClose(l)) break;
        body.push(l);
        pos = nextPos(src, pos);
      }
      pos = nextPos(src, pos);
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang, null)}"`;
      buf.push(`<pre><code${cls}>`);
      for (const l of body) buf.push(escapeHtml(l, null), '\n');
      buf.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      let slug = slugCache.get(heading.text);
      if (slug === undefined) { slug = slugifyRaw(heading.text); slugCache.set(heading.text, slug); }
      const id = uniqueSlug(slug, ids);
      const hhtml = inlineStr(heading.text, env);
      buf.push(`<h${heading.depth} id="${id}">`, hhtml, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: hhtml });
      pos = nextPos(src, pos);
      continue;
    }
    if (isHr(line)) {
      buf.push('<hr>\n');
      pos = nextPos(src, pos);
      continue;
    }
    if (line.charCodeAt(0) === 62) { // '>'
      const qlines = [];
      while (pos <= total) {
        const l = lineAt(src, pos);
        if (l.charCodeAt(0) !== 62) break;
        let t = l.slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimST(t);
        if (t !== '') qlines.push(t);
        pos = nextPos(src, pos);
      }
      if (qlines.length === 0) buf.push('<blockquote>\n</blockquote>\n');
      else {
        buf.push('<blockquote>\n<p>');
        inline(qlines.join('\n'), env, buf);
        buf.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // list?
    let isBullet = false;
    let isOrdered = false;
    let orderedStart = 1;
    let itemText = '';
    if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') {
      isBullet = true;
      itemText = line.slice(2);
    } else {
      let d = 0;
      while (d < 9 && d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d > 0 && d < line.length && line[d] === '.' && line[d + 1] === ' ') {
        isOrdered = true;
        orderedStart = Number(line.slice(0, d));
        itemText = line.slice(d + 2);
      }
    }
    if (isBullet || isOrdered) {
      const items = [];
      pos = nextPos(src, pos);
      items.push([trimST(itemText)]);
      while (pos <= total) {
        const l = lineAt(src, pos);
        let mText = null;
        let match = false;
        if (isBullet) {
          if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') { match = true; mText = l.slice(2); }
        } else {
          let d = 0;
          while (d < 9 && d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d > 0 && d < l.length && l[d] === '.' && l[d + 1] === ' ') { match = true; mText = l.slice(d + 2); }
        }
        if (match) {
          items.push([trimST(mText)]);
          pos = nextPos(src, pos);
        } else {
          // CONTINUED: /^ {2,}\S/ — two or more spaces then a non-space char
          let sp = 0;
          while (sp < l.length && l[sp] === ' ') sp++;
          if (sp >= 2 && sp < l.length && l[sp] !== ' ' && l[sp] !== '\t') {
            items[items.length - 1].push(trimST(l));
            pos = nextPos(src, pos);
          } else break;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && orderedStart !== 1 ? `<ol start="${orderedStart}">` : `<${tag}>`;
      buf.push(`${open}\n`);
      for (const parts of items) {
        buf.push('<li>');
        inline(parts.join('\n'), env, buf);
        buf.push('</li>\n');
      }
      buf.push(`</${tag}>\n`);
      continue;
    }
    // paragraph
    const body = [trimST(line)];
    pos = nextPos(src, pos);
    while (pos <= total) {
      const l = lineAt(src, pos);
      if (endsParagraph(l)) break;
      body.push(trimST(l));
      pos = nextPos(src, pos);
    }
    // The first paragraph is also the excerpt, so it needs its HTML as a
    // string; later paragraphs inline straight into the page buffer, which
    // joins to exactly the same text ('<p>' + html + '</p>\n').
    const text = body.join('\n');
    if (excerpt === null) {
      const phtml = inlineStr(text, env);
      excerpt = phtml;
      buf.push('<p>', phtml, '</p>\n');
    } else {
      buf.push('<p>');
      inline(text, env, buf);
      buf.push('</p>\n');
    }
  }
  return { html: buf.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates
// Two renderers share one scope model: a single merged scope object S.
// A for loop binds its variable (and `loop`) on S, saving and restoring the
// previous values, so a lookup is one hasOwn on S plus own-property descents
// — no scope-chain walk, no per-item scope object.

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const KIND_NAME = { 3: 'for', 4: 'if' };

// Node kinds: 0 text, 1 var, 2 raw, 3 for, 4 if, 5 include.
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankLine(src.slice(lineStart, open)) && isBlankLine(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { k: 9, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? 1 : 2, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 3, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 4, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 4 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 3 : 4)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 9 ? parent.body : parent.k === 3 ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${KIND_NAME[stack[stack.length - 1].k]} is not closed`);
  return root.body;
}

// Free-variable analysis for include memoisation. A template whose free
// variables are all among the per-case constants (site, tags, recent)
// renders the same string in every page render of the case, so its
// rendering can be computed once per case (per include depth, since the
// depth guard can cut nested includes) and reused; anything else renders
// normally. Computed by fixpoint iteration so include cycles stay safe.
// Guard: if any template anywhere binds a loop variable named site, tags
// or recent, a loop could shadow a constant and memoisation is disabled
// for the whole run (the competition's generator only ever binds p, t, h).
const CASE_CONSTANTS = new Set(['site', 'tags', 'recent']);

function walkFree(nodes, bound, acc, free, loopNames) {
  for (const n of nodes) {
    if (n.k === 1 || n.k === 2) {
      if (!bound.has(n.path[0])) acc.add(n.path[0]);
    } else if (n.k === 4) {
      if (!bound.has(n.path[0])) acc.add(n.path[0]);
      if (n.then) walkFree(n.then, bound, acc, free, loopNames);
      if (n.els) walkFree(n.els, bound, acc, free, loopNames);
    } else if (n.k === 3) {
      if (!bound.has(n.path[0])) acc.add(n.path[0]);
      loopNames.add(n.name);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      walkFree(n.body, b2, acc, free, loopNames);
    } else if (n.k === 5) {
      const sub = free.get(n.name);
      if (sub !== undefined) for (const v of sub) if (!bound.has(v)) acc.add(v);
    }
  }
}

// Returns { memoizable: Set<name>, objVar: Map<name, varName> } — the
// templates safe to memoise: memoizable renders only from the per-case
// constants; objVar names the templates whose free variables are the
// constants plus exactly one varying object (never `loop`, whose fields
// mutate per iteration), so their rendering can be cached per object.
function analyseTemplates(templates) {
  const free = new Map();
  for (const name of templates.keys()) free.set(name, new Set());
  const loopNames = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of templates) {
      const acc = free.get(name);
      const before = acc.size;
      walkFree(nodes, new Set(), acc, free, loopNames);
      if (acc.size !== before) changed = true;
    }
  }
  const shadowed = [...loopNames].some((n) => CASE_CONSTANTS.has(n));
  const memoizable = new Set();
  const objVar = new Map();
  if (!shadowed) {
    for (const [name, vars] of free) {
      const varying = [...vars].filter((v) => !CASE_CONSTANTS.has(v));
      if (varying.length === 0) memoizable.add(name);
      else if (varying.length === 1 && varying[0] !== 'loop') objVar.set(name, varying[0]);
    }
  }
  return { memoizable, objVar };
}

/** The value at `path` in merged scope S (first name an own property of S). */
function lk(S, path) {
  let v = Object.hasOwn(S, path[0]) ? S[path[0]] : undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, S, ctx, depth, buf) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.k === 0) {
      buf.push(n.text);
    } else if (n.k === 1) {
      buf.push(escapeHtml(textOf(lk(S, n.path)), ctx.escCache));
    } else if (n.k === 2) {
      buf.push(textOf(lk(S, n.path)));
    } else if (n.k === 4) {
      const v = truthy(lk(S, n.path));
      const branch = v !== n.not ? n.then : n.els;
      if (branch !== null) renderNodes(branch, S, ctx, depth, buf);
    } else if (n.k === 3) {
      const xs = lk(S, n.path);
      if (Array.isArray(xs)) {
        const loop = { index: 0, first: true, last: false, length: xs.length };
        const sv = S[n.name];
        const sh = Object.hasOwn(S, n.name);
        const sl = S.loop;
        const slh = Object.hasOwn(S, 'loop');
        S.loop = loop;
        for (let k = 0; k < xs.length; k++) {
          S[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, S, ctx, depth, buf);
        }
        if (sh) S[n.name] = sv; else S[n.name] = undefined;
        if (slh) S.loop = sl; else S.loop = undefined;
      }
    } else {
      const nodes2 = ctx.templates.get(n.name);
      if (nodes2 !== undefined && depth < 8) {
        if (ctx.memoizable.has(n.name)) {
          // Renders only from the per-case constants, so the string is the
          // same at every include site; cache it per include depth.
          const key = `${n.name}@${depth + 1}`;
          let s = ctx.includeCache.get(key);
          if (s === undefined) {
            const b2 = [];
            renderNodes(nodes2, S, ctx, depth + 1, b2);
            s = b2.join('');
            ctx.includeCache.set(key, s);
          }
          buf.push(s);
        } else if (ctx.objVar.has(n.name)) {
          // Renders only from the constants plus one varying object; the
          // object is never mutated after it is built (cards are built once
          // and pageOf mutates a fresh card, not the cached one), so the
          // string is the same every time this object is rendered.
          const v = S[ctx.objVar.get(n.name)];
          let done = false;
          if (v !== null && typeof v === 'object') {
            const key = `${n.name}@${depth + 1}`;
            let perObj = ctx.objCache.get(v);
            if (perObj === undefined) { perObj = new Map(); ctx.objCache.set(v, perObj); }
            let s = perObj.get(key);
            if (s === undefined) {
              const b2 = [];
              renderNodes(nodes2, S, ctx, depth + 1, b2);
              s = b2.join('');
              perObj.set(key, s);
            }
            buf.push(s);
            done = true;
          }
          if (!done) renderNodes(nodes2, S, ctx, depth + 1, buf);
        } else renderNodes(nodes2, S, ctx, depth + 1, buf);
      }
    }
  }
}

// ---------------------------------------------------------------- build

function isScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true; // ':'
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

export function run(input) {
  const slugCache = new Map();
  const escCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) { s = slugifyRaw(text); slugCache.set(text, s); }
    return s;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // markdown
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (isScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveFrom(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const sl = slugify(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = [];
      for (const name of ownTags(s)) {
        const sl = slugify(name);
        s.tagRefs.push(bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] });
      }
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  // The tag objects a card carries are read-only for the templates, so one
  // array per source is shared by every card built from it.
  function tagArrOf(s) {
    if (s.tagArr === undefined) s.tagArr = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    return s.tagArr;
  }

  function cardOf(s) {
    if (s.readingMinutes === undefined) s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: tagArrOf(s),
    };
  }

  function pageOf(s) {
    const card = cardOf(s);
    card.slug = s.slug;
    card.content = s.html;
    card.toc = s.toc;
    card.newer = linkOf(s.newer ?? null);
    card.older = linkOf(s.older ?? null);
    card.is_post = s.post;
    return card;
  }

  // layouts
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const { memoizable, objVar } = analyseTemplates(templates);
  const ctx = { templates, escCache, memoizable, objVar, includeCache: new Map(), objCache: new WeakMap() };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const S = { site, tags: allTags, recent, ...vars };
    const buf = [];
    renderNodes(nodes, S, ctx, 0, buf);
    return buf.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // report
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
