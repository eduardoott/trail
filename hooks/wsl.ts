import type { EngineInterface } from 'claude-code'
import type { Repo } from '../types'

const UNC = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)(.*)$/i

export function isUnc(path: string): boolean {
  return /^[\\/]{2}wsl/i.test(path)
}

export function fromUnc(path: string): { distro: string; linux: string } | null {
  const m = UNC.exec(path.trim())
  if (!m) return null
  const linux = (m[2] ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  return { distro: m[1] ?? '', linux: linux || '/' }
}

export function toUnc(distro: string, linux: string): string {
  return `//wsl.localhost/${distro}${linux === '/' ? '' : linux}`
}

export function winForm(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\/([A-Za-z])(\/|$)/, '$1:/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
  return /^[A-Za-z]:\/$/.test(p) ? p : p.replace(/\/+$/, '')
}

export function mntToWin(linux: string): string | null {
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(linux)
  return m ? winForm(`${(m[1] ?? '').toUpperCase()}:${m[2] ?? '/'}`) : null
}

export function repoOf(kind: 'wsl' | 'win', top: string, distro = ''): Repo {
  if (kind === 'wsl') return { key: `wsl:${top}`, root: toUnc(distro, top), kind, distro, linux: top }
  const root = winForm(top)
  return { key: `win:${root}`, root, kind, distro: '', linux: '' }
}

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

// Pane ids allow only letters, digits, `_` and `-`, up to 64 characters.
export function paneId(key: string): string {
  const name = (key.split('/').filter(Boolean).pop() ?? 'repo').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40)
  return `rx-${key.startsWith('wsl:') ? 'wsl' : 'win'}-${name}-${hash(key)}`
}

export function titleOf(repo: Repo): string {
  const name = repo.root.split('/').filter(Boolean).pop() ?? repo.root
  return repo.kind === 'wsl' ? `WSL ${name}` : name
}

// The same path in the form the repo's tree uses for its node ids, or null outside the repo.
export function inRepo(repo: Repo, path: string): string | null {
  let p: string
  if (repo.kind === 'wsl') {
    const u = fromUnc(path)
    const home = /^\/home\/[^/]+/.exec(repo.linux)?.[0]
    if (u) {
      if (u.distro.toLowerCase() !== repo.distro.toLowerCase()) return null
      p = u.linux
    } else if (home && (path === '~' || path.startsWith('~/'))) p = (home + path.slice(1)).replace(/\/+$/, '')
    else if (path.startsWith('/') && !path.startsWith('//')) p = path.replace(/\/+$/, '') || '/'
    else return null
    if (p !== repo.linux && !p.startsWith(`${repo.linux}/`)) return null
    return repo.root + p.slice(repo.linux.length)
  }
  p = isUnc(path) ? '' : (mntToWin(path) ?? winForm(path))
  const r = repo.root.toLowerCase()
  const l = p.toLowerCase()
  if (l !== r && !l.startsWith(r.endsWith('/') ? r : `${r}/`)) return null
  return repo.root + p.slice(repo.root.length)
}

export function linuxOf(repo: Repo, treePath: string): string {
  return repo.linux + treePath.slice(repo.root.length)
}

// Whether a shell command names the repo in any of the forms it can take there.
export function mentions(repo: Repo, command: string): boolean {
  const text = command.replace(/\\/g, '/').toLowerCase()
  if (repo.kind === 'win') {
    const r = repo.root.toLowerCase()
    const mnt = `/mnt/${r[0] ?? ''}${r.slice(2)}`
    return text.includes(r) || text.includes(mnt)
  }
  const forms = [repo.linux, `${repo.distro}${repo.linux}`]
  const home = /^\/home\/[^/]+(\/.*)$/.exec(repo.linux)?.[1]
  if (home) forms.push(`~${home}`, `$home${home}`)
  return forms.some(f => {
    const at = text.indexOf(f.toLowerCase())
    return at >= 0 && !/[a-z0-9_.-]/i.test(text[at + f.length] ?? '')
  })
}

// With "up" in $2 a path that does not exist yet (a file about to be written) climbs to the nearest folder that does.
const FIND_TOP = 'd="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/${d#"~/"}";; esac; if [ "$2" = up ]; then while [ ! -d "$d" ] && [ "$d" != / ]; do d=$(dirname "$d"); done; fi; cd "$d" && git rev-parse --show-toplevel && echo "$WSL_DISTRO_NAME"'

export type Resolved = { repo: Repo } | { error: string }

export async function resolveRepo($: EngineInterface, input: string, cwd: string, climb = false): Promise<Resolved> {
  const arg = input.trim().replace(/^["']|["']$/g, '')
  if (!arg) return { error: 'falta a pasta' }
  const unc = fromUnc(arg)
  const mnt = !unc && arg.startsWith('/') ? (mntToWin(arg) ?? (/^\/[A-Za-z](\/|$)/.test(arg) ? winForm(arg) : null)) : null
  if (unc || (!mnt && (arg.startsWith('~') || (arg.startsWith('/') && !arg.startsWith('//'))))) {
    const argv = ['wsl.exe', ...(unc ? ['-d', unc.distro] : []), '-e', 'sh', '-c', FIND_TOP, 'sh', unc ? unc.linux : arg, climb ? 'up' : '']
    try {
      const run = await $.process.run(argv, { timeoutMs: 30_000 })
      const [top = '', distro = ''] = run.stdout.replace(/\r/g, '').trim().split('\n')
      if (run.exitCode !== 0 || !top) return { error: `${arg} não está num repo git do WSL` }
      return { repo: repoOf('wsl', top.trim(), (distro.trim() || unc?.distro) ?? '') }
    } catch (err) {
      return { error: `wsl.exe falhou: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  let dir = mnt ?? (/^[A-Za-z]:[\\/]/.test(arg) ? winForm(arg) : winForm(`${cwd}/${arg}`))
  if (climb) dir = await nearestDir($, dir)
  try {
    const run = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 })
    const top = run.stdout.trim()
    if (run.exitCode !== 0 || !top) return { error: `${dir} não está num repo git` }
    return { repo: repoOf('win', top) }
  } catch (err) {
    return { error: `git falhou: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function nearestDir($: EngineInterface, path: string): Promise<string> {
  let dir = path
  for (let i = 0; i < 32; i++) {
    try {
      if ((await $.fs.stat(dir)).kind === 'dir') return dir
    } catch {
      // not there yet
    }
    const up = dir.replace(/\/[^/]*$/, '')
    if (!up || up === dir || /^[A-Za-z]:$/.test(up)) return /^[A-Za-z]:$/.test(up) ? `${up}/` : dir
    dir = up
  }
  return dir
}
