// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** A moved file's current path maps to the path it had before any move. */
  readonly moved = new Map<string, string>();
  recordMove(oldP: string, newP: string): void {
    this.moved.set(newP, this.moved.get(oldP) ?? oldP);
    this.moved.delete(oldP);
  }
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

type Edit = (tree: Tree) => void;

/** Split a file's text into its lines, its line break and whether it ends with one (section 3). */
function splitFile(text: string): { lines: string[]; br: string; fin: boolean } {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/** One line as a tier sees it: exact, trailing whitespace off, or both ends off. */
function tierView(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file lines at one tier. */
function tierHits(lines: string[], old: string[], tier: number): number[] {
  const want = old.map((l) => tierView(l, tier));
  const hits: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (tierView(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier at which O occurs, with its positions, or null. */
function tierFind(lines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const at = tierHits(lines, old, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A new line of N as tier 2 re-indents it; context lines are never passed here. */
function reindented(line: string, old: string[], fileFirst: string, tier: number): string {
  if (tier !== 2 || old.length === 0) return line;
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  const p = leadWs(old[0]!);
  if (!line.startsWith(p)) return line;
  return leadWs(fileFirst) + line.slice(p.length);
}

/** Replace the k lines at `at` with N; ctx[j] is the index into O of a context line, else -1. */
function spliceLines(lines: string[], at: number, old: string[], next: string[], ctx: number[], tier: number): string[] {
  const out = lines.slice(0, at);
  for (let j = 0; j < next.length; j += 1) {
    const c = ctx[j]!;
    out.push(c >= 0 ? lines[at + c]! : reindented(next[j]!, old, lines[at]!, tier));
  }
  out.push(...lines.slice(at + old.length));
  return out;
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

/** One unified hunk: A is the old start, O/N the old/new lines, ctx the context map. */
interface Hunk {
  a: number;
  o: string[];
  n: string[];
  ctx: number[];
  noNl: boolean;
  noNlPlus: boolean;
}

/** Apply one hunk to a file's split lines; d is the drift of earlier hunks of the section. */
function useHunk(split: { lines: string[]; br: string; fin: boolean }, h: Hunk, d: number, strict: boolean): { lines: string[]; br: string; fin: boolean } {
  const lines = split.lines;
  if (h.o.length === 0) {
    const at = Math.min(h.a + d, lines.length);
    const out = lines.slice(0, at);
    for (const l of h.n) out.push(l);
    out.push(...lines.slice(at));
    const fin = at === lines.length ? !h.noNlPlus : split.fin;
    return { lines: out, br: split.br, fin };
  }
  const found = tierFind(lines, h.o, strict);
  if (found === null) throw new Fail('no-match', '');
  const want = h.a - 1 + d;
  let at = found.at[0]!;
  let best = Math.abs(at - want);
  for (const p of found.at) {
    const dist = Math.abs(p - want);
    if (dist < best) {
      best = dist;
      at = p;
    }
  }
  const fin = at + h.o.length === lines.length ? !h.noNl : split.fin;
  return { lines: spliceLines(lines, at, h.o, h.n, h.ctx, found.tier), br: split.br, fin };
}

/** Apply a section's hunks in order to a file's text. */
function useHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let split = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    try {
      split = useHunk(split, h, d, strict);
    } catch (e) {
      if (e instanceof Fail && e.code === 'no-match') throw new Fail('no-match', path);
      throw e;
    }
    d += h.n.length - h.o.length;
  }
  return joinFile(split.lines, split.br, split.fin);
}

/** One unified section: the paths each source named, resolved after the header. */
interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  pairSeen: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, spaces off, a/ or b/ off. */
function uniPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function hunkHead(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** Read one hunk body starting after its header; returns the hunk and the next index. */
function readHunk(lines: string[], i: number, a: number): { h: Hunk; next: number } {
  const body: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const h: Hunk = { a, o: [], n: [], ctx: [], noNl: false, noNlPlus: false };
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l[0] === '\\') continue;
    if (l[0] === ' ') {
      h.ctx.push(h.o.length);
      h.o.push(l.slice(1));
      h.n.push(l.slice(1));
    } else if (l[0] === '-') {
      h.o.push(l.slice(1));
    } else if (l[0] === '+') {
      h.ctx.push(-1);
      h.n.push(l.slice(1));
    } else {
      h.ctx.push(h.o.length);
      h.o.push('');
      h.n.push('');
    }
  }
  // A \ line after the hunk's last context or + line means the result has no final break.
  let lastCp = -1;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b === '' || b[0] === ' ' || b[0] === '+') {
      lastCp = k;
      break;
    }
  }
  if (lastCp >= 0 && body[lastCp + 1] !== undefined && body[lastCp + 1]![0] === '\\') h.noNl = true;
  let lastPlus = -1;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]![0] === '+') {
      lastPlus = k;
      break;
    }
  }
  if (lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\') h.noNlPlus = true;
  return { h, next: j };
}

/** Scan a unified patch into sections; a ---/+++ pair before the first hunk is the header's. */
function scanUniSections(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  const fresh = (): UniSection => ({
    gitOld: null, gitNew: null, pairSeen: false, pairOld: null, pairNew: null,
    renFrom: null, renTo: null, create: false, remove: false, hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const parts = l.split(' ');
      if (parts.length !== 4 || !parts[2]!.startsWith('a/') || !parts[3]!.startsWith('b/')) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      cur = fresh();
      cur.gitOld = parts[2]!.slice(2);
      cur.gitNew = parts[3]!.slice(2);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.pairSeen = true;
        cur.pairOld = uniPath(l);
        cur.pairNew = uniPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = fresh();
      cur.pairSeen = true;
      cur.pairOld = uniPath(l);
      cur.pairNew = uniPath(lines[i + 1]!);
      sections.push(cur);
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHead(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = readHunk(lines, i + 1, a);
      cur.hunks.push(r.h);
      i = r.next;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.renFrom = l.slice(12).split('\t')[0]!.trim();
      else if (l.startsWith('rename to ')) cur.renTo = l.slice(10).split('\t')[0]!.trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.remove = true;
    }
    i += 1;
  }
  return sections;
}

/** Turn unified sections into edits. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = scanUniSections(lines);
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.pairSeen ? s.pairOld : (s.renFrom ?? s.gitOld);
    const newP = s.pairSeen ? s.pairNew : (s.renTo ?? s.gitNew);
    const isCreate = (s.create || oldP === null) && newP !== null;
    const isRemove = !isCreate && (s.remove || newP === null) && oldP !== null;
    const isMove = !isCreate && !isRemove && oldP !== null && newP !== null && oldP !== newP;
    if (oldP === null && newP === null) {
      edits.push(() => {});
      continue;
    }
    if (isCreate) {
      const np = newP!;
      const plus: string[] = [];
      let noNl = false;
      for (const h of s.hunks) {
        // The file is the + lines of all hunks; only the very last + line decides the ending.
        let hasPlus = false;
        for (let k = 0; k < h.n.length; k += 1) {
          if (h.ctx[k] === -1) {
            hasPlus = true;
            plus.push(h.n[k]!);
          }
        }
        if (hasPlus) noNl = h.noNlPlus;
      }
      edits.push((tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      });
      continue;
    }
    if (isRemove) {
      const op = oldP!;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
      continue;
    }
    if (isMove) {
      const op = oldP!;
      const np = newP!;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const after = useHunks(before, s.hunks, strict, op);
        tree.now.set(op, null);
        tree.now.set(np, after);
        tree.recordMove(op, np);
      });
      continue;
    }
    const p = oldP!;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, useHunks(before, s.hunks, strict, p));
    });
  }
  return edits;
}

/** Read SEARCH/REPLACE blocks into edits. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let j = searchIdx + 1;
    const old: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      old.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    j += 1;
    const next: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      next.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    prevEnd = j;
    prevPath = path;
    const p = path;
    const o = old;
    const n = next;
    if (o.length === 0) {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
      });
    } else {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const split = splitFile(before);
        const found = tierFind(split.lines, o, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.at.length > 1) throw new Fail('ambiguous', p);
        const at = found.at[0]!;
        const ctx = n.map(() => -1);
        tree.now.set(p, joinFile(spliceLines(split.lines, at, o, n, ctx, found.tier), split.br, split.fin));
      });
    }
    i = j + 1;
  }
  return edits;
}

/** One V4A chunk: an anchor (null is none), an end-of-file mark, and its old/new lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  ctx: number[];
}

/** Parse an Update File section body into its move target and its chunks. */
function v4aChunks(body: { text: string; num: number }[], headNum: number): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
    moveTo = body[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let open = false;
  for (; idx < body.length; idx += 1) {
    const e = body[idx]!;
    const l = e.text;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [], ctx: [] };
      chunks.push(cur);
      open = true;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (!open || cur === null) throw new Exit2(`error: parse ${e.num}`);
      cur.eof = true;
      open = false;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${e.num}`);
        cur = { anchor: null, eof: false, o: [], n: [], ctx: [] };
        chunks.push(cur);
        open = true;
      }
      if (l === '') {
        cur.ctx.push(cur.o.length);
        cur.o.push('');
        cur.n.push('');
      } else if (l[0] === ' ') {
        cur.ctx.push(cur.o.length);
        cur.o.push(l.slice(1));
        cur.n.push(l.slice(1));
      } else if (l[0] === '-') {
        cur.o.push(l.slice(1));
      } else {
        cur.ctx.push(-1);
        cur.n.push(l.slice(1));
      }
      continue;
    }
    throw new Exit2(`error: parse ${e.num}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNum}`);
  return { moveTo, chunks };
}

/** Apply one V4A chunk to a file's split lines at the cursor; returns the new split and cursor. */
function useVChunk(split: { lines: string[]; br: string; fin: boolean }, c: VChunk, cursor: number, strict: boolean, path: string): { split: { lines: string[]; br: string; fin: boolean }; cursor: number } {
  let at = cursor;
  if (c.anchor !== null) {
    const top = strict ? 0 : 2;
    let found = -1;
    for (let t = 0; t <= top && found < 0; t += 1) {
      for (let k = cursor; k < split.lines.length; k += 1) {
        if (tierView(split.lines[k]!, t) === tierView(c.anchor!, t)) {
          found = k;
          break;
        }
      }
    }
    if (found < 0) throw new Fail('no-match', path);
    at = found + 1;
  }
  if (c.o.length === 0) {
    const pos = c.eof ? split.lines.length : at;
    const out = split.lines.slice(0, pos);
    for (const l of c.n) out.push(l);
    out.push(...split.lines.slice(pos));
    return { split: { lines: out, br: split.br, fin: split.fin }, cursor: pos + c.n.length };
  }
  const top = strict ? 0 : 2;
  let pick: { tier: number; at: number } | null = null;
  for (let t = 0; t <= top && pick === null; t += 1) {
    for (const pos of tierHits(split.lines, c.o, t)) {
      if (pos < at) continue;
      if (c.eof && pos + c.o.length !== split.lines.length) continue;
      pick = { tier: t, at: pos };
      break;
    }
  }
  if (pick === null) throw new Fail('no-match', path);
  const out = spliceLines(split.lines, pick.at, c.o, c.n, c.ctx, pick.tier);
  return { split: { lines: out, br: split.br, fin: split.fin }, cursor: pick.at + c.n.length };
}

/** Read a V4A patch into edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const head = lines[i]!;
    let kind = '';
    let path = '';
    if (head.startsWith('*** Add File: ')) {
      kind = 'add';
      path = head.slice(14).trim();
    } else if (head.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = head.slice(17).trim();
    } else if (head.startsWith('*** Update File: ')) {
      kind = 'update';
      path = head.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headNum = i + 1;
    i += 1;
    const body: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      body.push({ text: l, num: i + 1 });
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const made: string[] = [];
      for (const e of body) {
        if (e.text === '') made.push('');
        else if (e.text[0] === '+') made.push(e.text.slice(1));
        else throw new Exit2(`error: parse ${e.num}`);
      }
      const p = path;
      const content = made.length === 0 ? '' : made.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content);
      });
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.num}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const { moveTo, chunks } = v4aChunks(body, headNum);
      const p = path;
      const mt = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        let split = splitFile(before);
        let cursor = 0;
        for (const c of chunks) {
          const r = useVChunk(split, c, cursor, strict, p);
          split = r.split;
          cursor = r.cursor;
        }
        const after = joinFile(split.lines, split.br, split.fin);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, after);
          tree.recordMove(p, mt);
        } else {
          tree.now.set(p, after);
        }
      });
    }
  }
  return edits;
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [np, op] of tree.moved) {
    if (op === np) continue;
    if (tree.original(op) !== null && tree.get(op) === null && tree.original(np) === null && tree.get(np) !== null) {
      rows.push({ key: np, line: `R ${op} -> ${np}` });
      covered.add(op);
      covered.add(np);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
