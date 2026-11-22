// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs (section 6), SEARCH/REPLACE
// blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type MoveInfo = { oldPath: string; newPath: string };
type Edit = (tree: Tree) => MoveInfo | void;

/** A file's lines, its own line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalBr: false };
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

const trailWS = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const wsOnly = (s: string): boolean => /^[ \t]*$/.test(s);

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWS(a) === trailWS(b);
  return bothWS(a) === bothWS(b);
}

/** Positions where old occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!tierEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2; only 0 when strict) where old occurs at least once. */
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First tier where one line occurs at or after from; both sides a single line. */
function findLineTier(lines: string[], want: string, from: number, strict: boolean): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (tierEq(lines[i]!, want, t)) return { tier: t, at: i };
    }
  }
  return null;
}

/** One line of N: a context line keeps the file's own line, other lines re-indent at tier 2. */
interface NewEntry {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function buildNew(entries: NewEntry[], file: string[], at: number, oldFirst: string, tier: number): string[] {
  const out: string[] = [];
  const f = at < file.length ? leadWS(file[at]!) : '';
  const p = leadWS(oldFirst);
  for (const e of entries) {
    if (e.ctx) {
      out.push(file[at + e.oIdx]!);
      continue;
    }
    const t = e.text;
    if (tier === 2 && t !== '' && !wsOnly(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

/** A unified hunk or V4A chunk body, read as old lines and new entries. */
interface HunkBody {
  old: string[];
  entries: NewEntry[];
  /** A `\` line follows the body's last context or `+` line. */
  noNL: boolean;
  /** A `\` line follows the body's last `+` line. */
  plusNoNL: boolean;
}

function parseHunkBody(body: string[]): HunkBody {
  const old: string[] = [];
  const entries: NewEntry[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i]!;
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      entries.push({ text, ctx: true, oIdx: old.length });
      old.push(text);
      lastCtxPlus = i;
    } else if (l[0] === '-') {
      old.push(l.slice(1));
    } else if (l[0] === '+') {
      entries.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxPlus = i;
      lastPlus = i;
    }
  }
  const follows = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  return { old, entries, noNL: follows(lastCtxPlus), plusNoNL: follows(lastPlus) };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified-diff section (SPEC section 6). */
interface UniHunk {
  a: number;
  body: string[];
}

interface UniSection {
  dashOld?: string | null;
  dashNew?: string | null;
  renameOld?: string | null;
  renameNew?: string | null;
  gitOld?: string | null;
  gitNew?: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UniHunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, spaces removed, a/ or b/ removed. */
function parseUniPath(l: string): string | null {
  let p = l.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const t = lines[j]!;
        if (t.startsWith('diff --git ')) break;
        if (t.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+' || t[0] === '\\') {
          body.push(t);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && inHeader && cur.dashOld === undefined) {
          cur.dashOld = parseUniPath(l);
          cur.dashNew = parseUniPath(next);
        } else {
          cur = { dashOld: parseUniPath(l), dashNew: parseUniPath(next), isCreate: false, isDelete: false, hunks: [] };
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('+++ ')) {
        cur.dashNew = parseUniPath(l);
      } else if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const pick = (a?: string | null, b?: string | null, c?: string | null): string | null =>
      (a !== undefined ? a : b !== undefined ? b : c !== undefined ? c : null);
    const oldP = pick(s.dashOld, s.renameOld, s.gitOld);
    const newP = pick(s.dashNew, s.renameNew, s.gitNew);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    if (oldP === null || s.isCreate) {
      const target = newP!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      let plusLines: string[] = [];
      let plusNoNL = false;
      for (const h of s.hunks) {
        const b = parseHunkBody(h.body);
        const plus = b.entries.filter((e) => !e.ctx).map((e) => e.text);
        if (plus.length > 0) {
          plusLines = plusLines.concat(plus);
          plusNoNL = b.plusNoNL;
        }
      }
      tree.now.set(target, joinFile({ lines: plusLines, br: '\n', finalBr: plusLines.length > 0 && !plusNoNL }));
      return;
    }
    if (newP === null || s.isDelete) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const path = oldP;
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const b = parseHunkBody(h.body);
      if (b.old.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const ins = b.entries.map((e) => e.text);
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...ins);
        if (atEnd) f.finalBr = !b.noNL;
        d += ins.length;
        continue;
      }
      const found = findTier(f.lines, b.old, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + b.old.length === f.lines.length;
      const repl = buildNew(b.entries, f.lines, best, b.old[0]!, found.tier);
      f.lines.splice(best, b.old.length, ...repl);
      if (runsToEnd) f.finalBr = !b.noNL;
      d += repl.length - b.old.length;
    }
    const out = joinFile(f);
    if (oldP !== newP) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      return { oldPath: oldP, newPath: newP };
    }
    tree.now.set(oldP, out);
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: newLines, br: '\n', finalBr: newLines.length > 0 }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const entries: NewEntry[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const repl = buildNew(entries, f.lines, at, oldLines[0]!, found.tier);
    f.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

/** One V4A section (SPEC section 8). */
interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
  lineNo: number;
  addLines: string[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind, path, moveTo: null, chunks: [], lineNo: i + 1, addLines: [] };
    i += 1;
    const start = i;
    let end = i;
    while (end < last) {
      const t = lines[end]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      end += 1;
    }
    let secEnd = end;
    while (secEnd > start && blank(lines[secEnd - 1]!)) secEnd -= 1;
    const secLines = lines.slice(start, secEnd);
    if (kind === 'add') {
      for (let j = 0; j < secLines.length; j += 1) {
        const t = secLines[j]!;
        if (t === '' || t.startsWith('+')) continue;
        throw new Exit2(`error: parse ${start + j + 1}`);
      }
      sec.addLines = secLines.map((t) => (t === '' ? '' : t.slice(1)));
    } else if (kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${start + 1}`);
    } else {
      let j = 0;
      if (j < secLines.length && secLines[j]!.startsWith('*** Move to: ')) {
        sec.moveTo = secLines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      let cur: VChunk | null = null;
      let chunkOpen = false;
      let firstChunk = true;
      for (; j < secLines.length; j += 1) {
        const t = secLines[j]!;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim(), body: [], eof: false };
          sec.chunks.push(cur);
          chunkOpen = true;
          firstChunk = false;
          continue;
        }
        if (t.trimEnd() === '*** End of File') {
          if (!chunkOpen || cur === null) throw new Exit2(`error: parse ${start + j + 1}`);
          cur.eof = true;
          chunkOpen = false;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (!chunkOpen) {
            if (!firstChunk) throw new Exit2(`error: parse ${start + j + 1}`);
            cur = { anchor: null, body: [], eof: false };
            sec.chunks.push(cur);
            chunkOpen = true;
            firstChunk = false;
          }
          cur!.body.push(t);
          continue;
        }
        throw new Exit2(`error: parse ${start + j + 1}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    sections.push(sec);
    i = end;
  }
  return sections.map((s) => vSectionEdit(s, strict));
}

function vSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, joinFile({ lines: s.addLines, br: '\n', finalBr: s.addLines.length > 0 }));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findLineTier(f.lines, ch.anchor, cursor, strict);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found.at + 1;
      }
      const b = parseHunkBody(ch.body);
      if (b.old.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = b.entries.map((e) => e.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let hit: { tier: number; at: number } | null = null;
      for (const t of tiers) {
        const occ = occurrences(f.lines, b.old, t).filter((p) => p >= cursor);
        const good = ch.eof ? occ.filter((p) => p + b.old.length === f.lines.length) : occ;
        if (good.length > 0) {
          hit = { tier: t, at: good[0]! };
          break;
        }
      }
      if (hit === null) throw new Fail('no-match', s.path);
      const repl = buildNew(b.entries, f.lines, hit.at, b.old[0]!, hit.tier);
      f.lines.splice(hit.at, b.old.length, ...repl);
      cursor = hit.at + repl.length;
    }
    const out = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      return { oldPath: s.path, newPath: s.moveTo };
    }
    tree.now.set(s.path, out);
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: MoveInfo[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = edit(tree);
      if (m !== undefined) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const paired = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    const o = changed.get(m.oldPath);
    const n = changed.get(m.newPath);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null) {
      paired.add(m.oldPath);
      paired.add(m.newPath);
      rows.push({ key: m.newPath, text: `R ${m.oldPath} -> ${m.newPath}` });
    }
  }
  for (const [p, c] of changed) {
    if (paired.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out: string[] = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
