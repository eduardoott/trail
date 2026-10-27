// What a tool call writes to, as raw paths in the form the call names them.
import { fromUnc, isUnc, mntToWin, winForm } from './wsl'

// gone: a removal (rm, Remove-Item...) names it, and no later write in the command brings it back.
export type Target = { path: string; wsl: boolean; gone?: boolean }
// A write the command does not spell out (a variable, a glob): the folder its path starts in and how many levels
// under it the files can land.
export type Blind = Target & { depth: number }
type Ctx = { wsl: boolean; cwd: string | null; ps: boolean; reads: boolean; blind?: Blind[] }

const WRITE_ALL = new Set(['rm', 'rmdir', 'mkdir', 'touch', 'tee', 'truncate', 'unlink', 'shred'])
const REMOVERS = new Set(['rm', 'rmdir', 'unlink'])
const PS_REMOVERS = new Set(['remove-item', 'ri', 'del', 'erase', 'rd'])
// A whole segment that is a variable (or a `**`) can hold any number of folders: the diff looks this deep.
const BLIND_DEPTH = 4
const WRITE_MODE_FIRST = new Set(['chmod', 'chown', 'chgrp'])
const WRITE_LAST = new Set(['cp', 'mv', 'ln', 'install', 'rsync', 'scp'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const CDS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location'])
// do, then and else open a loop's or an if's body: the command after them is the one that runs.
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env', 'xargs', '&', 'call', 'do', 'then', 'else'])
const PS_WRITE_ALL = new Set(['set-content', 'add-content', 'out-file', 'new-item', 'remove-item', 'clear-content', 'ni', 'ri', 'del', 'erase', 'rd', 'md', 'sc', 'ac', 'tee-object'])
const PS_WRITE_LAST = new Set(['copy-item', 'move-item', 'rename-item', 'copy', 'move', 'ren', 'cpi', 'mi', 'rni'])
const PS_PATH_FLAGS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-target'])
const PS_VALUE_FLAGS = new Set(['-value', '-itemtype', '-type', '-encoding', '-filter', '-include', '-exclude', '-name', '-newname', '-stream', '-width', '-inputobject', '-credential'])
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'wc', 'ls', 'eza', 'tree', 'find', 'fd', 'stat', 'file', 'diff'])
const PATTERN_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk'])
const PS_READERS = new Set(['get-content', 'gc', 'type', 'get-childitem', 'gci', 'dir', 'get-item', 'gi', 'test-path', 'resolve-path'])
const NOWHERE = /^(\/dev\/(null|stdout|stderr|tty)|nul|\$null|&\d|-)$/i
const OPS = new Set([';', '&&', '||', '|', '&', '(', ')'])

// Bash keeps a backslash before an ordinary character, so a Windows path survives unquoted;
// PowerShell's escape is the backtick and a backslash is always literal.
export function tokens(command: string, ps: boolean): string[] {
  const out: string[] = []
  let tok = ''
  let has = false
  let quote = ''
  const end = () => {
    if (has) out.push(tok)
    tok = ''
    has = false
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? ''
    const nx = command[i + 1] ?? ''
    if (quote === "'") {
      if (ch === "'") quote = ''
      else tok += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = ''
      else if (!ps && ch === '\\' && '"\\$`'.includes(nx) && nx) tok += command[++i]
      else if (ps && ch === '`' && nx) tok += command[++i]
      else tok += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (!ps && ch === '\\' && nx && ' \t"\'\\$`;&|()<>\n'.includes(nx)) {
      tok += command[++i]
      has = true
    } else if (ps && ch === '`' && nx && nx !== '\n') {
      tok += command[++i]
      has = true
    } else if (ch === ' ' || ch === '\t' || ch === '\r') end()
    else if (ch === '\n' || ch === ';') {
      end()
      out.push(';')
    } else if (ch === '>') {
      const fd = /^\d+$|^&$/.test(tok) && has ? tok : ''
      if (!fd) end()
      tok = ''
      has = false
      if (nx === '>') i++
      if (command[i + 1] === '&' || command[i + 1] === '|') i++
      out.push('>')
      // `2>&1` names a stream, not a file.
      if (command[i] === '&' && /\d/.test(command[i + 1] ?? '')) {
        while (/\d/.test(command[i + 1] ?? '')) i++
        out.push('&1')
      }
    } else if (ch === '<') end()
    else if (ch === '&' && nx === '>') end()
    else if (ch === '&' || ch === '|') {
      end()
      if (nx === ch) i++
      out.push(nx === ch ? ch + ch : ch)
    } else if (ch === '(' || ch === ')') {
      end()
      out.push(ch)
    } else {
      tok += ch
      has = true
    }
  }
  end()
  return out
}

function split(toks: string[]): string[][] {
  const segs: string[][] = []
  let cur: string[] = []
  for (const t of toks) {
    if (OPS.has(t)) {
      if (cur.length) segs.push(cur)
      cur = []
    } else cur.push(t)
  }
  if (cur.length) segs.push(cur)
  return segs
}

function joinPath(base: string, rel: string): string {
  const parts = base.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/') || '/'
}

// Where a path lands: the WSL distro (Linux path, `~` or UNC) or Windows. Null for a
// stream, a glob, a variable, or a relative path with no known folder.
export function place(raw: string, ctx: Ctx, home: string): Target | null {
  let p = raw.trim()
  if (!p || NOWHERE.test(p) || /[*?]/.test(p)) return null
  p = p.replace(/^\$\{?HOME\}?(?=\/|$)/, '~').replace(/^\$env:USERPROFILE(?=[\\/]|$)/i, home || '$env:USERPROFILE')
  if (p.includes('$')) return null
  if (isUnc(p)) return fromUnc(p) ? { path: p.replace(/\\/g, '/'), wsl: true } : null
  if (/^[A-Za-z]:([\\/]|$)/.test(p)) return { path: winForm(p), wsl: false }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    if (ctx.wsl) return { path: p.replace(/\\/g, '/'), wsl: true }
    return home ? { path: winForm(joinPath(home, p.slice(1))), wsl: false } : null
  }
  if (p.startsWith('/')) {
    const mnt = mntToWin(p)
    if (mnt) return { path: mnt, wsl: false }
    if (!ctx.wsl && /^\/[A-Za-z](\/|$)/.test(p)) return { path: winForm(p), wsl: false }
    if (ctx.wsl || p.startsWith('/home/')) return { path: joinPath('', p) || '/', wsl: true }
    return null
  }
  if (ctx.cwd === null) return null
  return place(joinPath(ctx.cwd, p), ctx, home)
}

// The folder a path place gave up on starts in: what comes before its first variable or wildcard. Null when it gave
// up for another reason (a stream, a relative path with no known folder).
function blindOf(raw: string, ctx: Ctx, home: string): Blind | null {
  const p = raw.trim().replace(/^\$\{?HOME\}?(?=\/|$)/, '~').replace(/^\$env:USERPROFILE(?=[\\/]|$)/i, home || '$env:USERPROFILE')
  if (!p || NOWHERE.test(p)) return null
  const cut = p.search(/[*?$]/)
  if (cut < 0) return null
  const slash = Math.max(p.lastIndexOf('/', cut), p.lastIndexOf('\\', cut))
  const dir = slash < 0 ? '.' : p.slice(0, slash) || '/'
  const rest = p.slice(slash + 1).split(/[\\/]/)
  const deep = rest.some(seg => seg === '**' || /^\$\{?[\w:]+\}?$/.test(seg))
  const t = place(dir, ctx, home)
  return t ? { ...t, depth: deep ? Math.max(rest.length, BLIND_DEPTH) : rest.length } : null
}

function writesOf(head: string, args: string[], ps: boolean): string[] {
  const plain = args.filter(a => !a.startsWith('-') || a === '-')
  if (ps && (PS_WRITE_ALL.has(head) || PS_WRITE_LAST.has(head))) {
    const named: string[] = []
    const positional: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? ''
      const flag = a.toLowerCase().replace(/:.*$/, '')
      if (PS_PATH_FLAGS.has(flag)) named.push(a.includes(':') && !/^-\w+:$/.test(a) ? a.slice(a.indexOf(':') + 1) : (args[++i] ?? ''))
      else if (PS_VALUE_FLAGS.has(flag)) i += a.includes(':') ? 0 : 1
      else if (!a.startsWith('-')) positional.push(a)
    }
    if (PS_WRITE_LAST.has(head)) return named.length ? named : positional.slice(-1)
    return [...named, ...positional]
  }
  if (WRITE_ALL.has(head)) return plain
  if (WRITE_MODE_FIRST.has(head)) return plain.slice(1)
  if (WRITE_LAST.has(head)) {
    const t = args.findIndex(a => a === '-t' || a === '--target-directory')
    return t >= 0 && args[t + 1] ? [args[t + 1] ?? ''] : plain.slice(-1)
  }
  if (head === 'sed' && args.some(a => /^-i|^--in-place/.test(a))) {
    const scripted = args.some(a => a === '-e' || a === '-f' || a === '--expression')
    const files = args.filter((a, i) => !a.startsWith('-') && !['-e', '-f', '--expression'].includes(args[i - 1] ?? ''))
    return scripted ? files : files.slice(1)
  }
  if (head === 'dd') return args.filter(a => a.startsWith('of=')).map(a => a.slice(3))
  return []
}

function readsOf(head: string, args: string[], ps: boolean): string[] {
  if (ps && PS_READERS.has(head)) return pathArgs(args)
  if (head === 'select-string' || head === 'sls') return args.some(a => /^-pattern$/i.test(a)) ? pathArgs(args) : pathArgs(args).slice(1)
  if (READERS.has(head)) return args.filter(a => !a.startsWith('-'))
  if (PATTERN_READERS.has(head)) {
    const given = args.some(a => a === '-e' || a === '-f' || a === '--regexp' || a === '--files')
    const plain = args.filter((a, i) => !a.startsWith('-') && !['-e', '-f', '--regexp', '-g', '--glob', '-t', '--type', '-m', '-A', '-B', '-C'].includes(args[i - 1] ?? ''))
    return given ? plain : plain.slice(1)
  }
  return []
}

function pathArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const flag = a.toLowerCase().replace(/:.*$/, '')
    if (PS_PATH_FLAGS.has(flag)) out.push(args[++i] ?? '')
    else if (PS_VALUE_FLAGS.has(flag) || flag === '-pattern' || flag === '-tail' || flag === '-first' || flag === '-totalcount') i += a.includes(':') ? 0 : 1
    else if (!a.startsWith('-')) out.push(a)
  }
  return out
}

function gitDir(args: string[], ctx: Ctx): string | null {
  let dir: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '-C') {
      const d = args[++i] ?? ''
      dir = dir && !/^([A-Za-z]:|[\\/~])/.test(d) ? joinPath(dir, d) : d
    } else if (!a.startsWith('-')) break
  }
  return dir ?? ctx.cwd
}

function walk(segment: string[], ctx: Ctx, home: string, out: Target[]): void {
  let toks = [...segment]
  const redirects: string[] = []
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== '>') continue
    const target = toks[i + 1]
    if (target && target !== '&1') redirects.push(target)
    toks.splice(i, target ? 2 : 1)
    i--
  }
  const write = (raw: string, gone: boolean) => {
    const t = place(raw, ctx, home)
    if (t) out.push(gone ? { ...t, gone } : t)
    else if (ctx.blind) {
      const b = blindOf(raw, ctx, home)
      if (b) ctx.blind.push(b)
    }
  }
  for (const r of redirects) write(r, false)
  while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0] ?? '') || WRAPPERS.has((toks[0] ?? '').toLowerCase()))) toks = toks.slice(1)
  const raw = toks[0] ?? ''
  const head = (raw.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '')
  const args = toks.slice(1)
  if (!head) return
  if (CDS.has(head)) {
    const flagged = args.findIndex(a => /^-(literal)?path$/i.test(a))
    const dir = flagged >= 0 ? args[flagged + 1] : args.find(a => !a.startsWith('-'))
    ctx.cwd = dir === undefined ? (ctx.wsl ? '~' : home || null) : ctx.cwd && !/^([A-Za-z]:|[\\/~])/.test(dir) ? joinPath(ctx.cwd, dir) : dir
    return
  }
  if (head === 'wsl') {
    const inner: Ctx = { wsl: true, cwd: null, ps: false, reads: ctx.reads, ...(ctx.blind ? { blind: ctx.blind } : {}) }
    let i = 0
    for (; i < args.length; i++) {
      const a = args[i] ?? ''
      if (a === '-d' || a === '--distribution' || a === '-u' || a === '--user' || a === '--shell-type') i++
      else if (a === '--cd') inner.cwd = args[++i] ?? null
      else if (a === '-e' || a === '--exec' || a === '--') {
        i++
        break
      } else if (!a.startsWith('-')) break
    }
    walk(args.slice(i), inner, home, out)
    return
  }
  if (SHELLS.has(head)) {
    const c = args.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a))
    const script = c >= 0 ? args[c + 1] : undefined
    if (script !== undefined) scan(script, { ...ctx, ps: false }, home, out)
    return
  }
  if (head === 'powershell' || head === 'pwsh') {
    const c = args.findIndex(a => /^-c(ommand)?$/i.test(a))
    if (c >= 0) scan(args.slice(c + 1).join(' '), { ...ctx, wsl: false, ps: true }, home, out)
    return
  }
  if (head === 'git') {
    const dir = gitDir(args, ctx)
    const t = dir === null ? null : place(dir, ctx, home)
    if (t) out.push(t)
    return
  }
  const removes = REMOVERS.has(head) || (ctx.ps && PS_REMOVERS.has(head))
  for (const a of writesOf(head, args, ctx.ps)) write(a, removes)
  for (const a of ctx.reads ? readsOf(head, args, ctx.ps) : []) {
    const t = place(a, ctx, home)
    if (t) out.push(t)
  }
}

function scan(command: string, ctx: Ctx, home: string, out: Target[]): void {
  for (const seg of split(tokens(command, ctx.ps))) walk(seg, ctx, home, out)
}

export function shellWrites(command: string, ps: boolean, home = '', wsl = false, reads = false, cwd: string | null = null): Target[] {
  const out: Target[] = []
  scan(command, { wsl, cwd, ps, reads }, home, out)
  // Each path once, where it first comes; the last write naming it says whether it ends gone.
  const seen = new Map<string, Target>()
  for (const t of out) {
    const k = `${t.wsl}|${t.path}`
    const first = seen.get(k)
    if (!first) seen.set(k, { ...t })
    else if (t.gone) first.gone = true
    else delete first.gone
  }
  return [...seen.values()]
}

// The folders a shell command writes into without spelling the files out, each once, at the deepest it reaches.
export function shellBlind(command: string, ps: boolean, home = '', cwd: string | null = null): Blind[] {
  const blind: Blind[] = []
  scan(command, { wsl: false, cwd, ps, reads: false, blind }, home, [])
  const seen = new Map<string, Blind>()
  for (const b of blind) {
    const k = `${b.wsl}|${b.path}`
    const first = seen.get(k)
    if (!first) seen.set(k, { ...b })
    else first.depth = Math.max(first.depth, b.depth)
  }
  return [...seen.values()]
}

// What a shell command only reads, for the purple flash after it ran.
export function shellReads(command: string, ps: boolean, home = '', cwd: string | null = null): Target[] {
  const key = (t: Target) => `${t.wsl}|${t.path}`
  const writes = new Set(shellWrites(command, ps, home, false, false, cwd).map(key))
  return shellWrites(command, ps, home, false, true, cwd).filter(t => !writes.has(key(t)))
}

// Writes always; with `reads` (the Reads too option) also Read, Grep, Glob and the shell readers.
export function writeTargets(e: { tool: string } & Record<string, unknown>, home = '', reads = false): Target[] {
  const ctx: Ctx = { wsl: false, cwd: null, ps: false, reads }
  const file = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : ''
  const one = (p: string) => {
    const t = p ? place(p, ctx, home) : null
    return t ? [t] : []
  }
  if (e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'NotebookEdit' || e.tool === 'MultiEdit') return one(file)
  if (reads && e.tool === 'Read') return one(file)
  if (reads && (e.tool === 'Grep' || e.tool === 'Glob')) return one(typeof e.path === 'string' ? e.path : '')
  if ((e.tool === 'Bash' || e.tool === 'PowerShell') && typeof e.command === 'string') return shellWrites(e.command, e.tool === 'PowerShell', home, false, reads)
  return []
}

// Inside the session: under the folder it started in or its current project root.
export function insideSession(t: Target, dirs: string[]): boolean {
  const form = (p: string) => {
    const u = fromUnc(p)
    return (u ? `//wsl.localhost/${u.distro}${u.linux === '/' ? '' : u.linux}` : winForm(p)).toLowerCase()
  }
  if (t.wsl && !isUnc(t.path)) return false
  const p = form(t.path)
  return dirs.filter(Boolean).some(d => {
    const r = form(d)
    return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`)
  })
}
