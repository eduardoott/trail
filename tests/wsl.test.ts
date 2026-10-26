import { expect, test } from 'claude-code/testing'
import { fromUnc, inRepo, linuxOf, mentions, mntToWin, paneId, repoOf, titleOf, toUnc, winForm } from '../hooks/wsl'

const wsl = repoOf('wsl', '/home/user/meu-repo', 'Ubuntu')
const win = repoOf('win', 'C:\\Users\\user\\Documents\\Code\\outro')

test('the canonical key and the tree root of a WSL and a Windows repo', () => {
  expect(wsl.key).toBe('wsl:/home/user/meu-repo')
  expect(wsl.root).toBe('//wsl.localhost/Ubuntu/home/user/meu-repo')
  expect(win.key).toBe('win:C:/Users/user/Documents/Code/outro')
  expect(win.root).toBe('C:/Users/user/Documents/Code/outro')
  expect(repoOf('win', 'c:/x/').key).toBe('win:C:/x')
  expect(winForm('/c/Users/x')).toBe('C:/Users/x')
  expect(winForm('C:\\')).toBe('C:/')
})

test('UNC paths turn into distro and Linux path and back, in both spellings', () => {
  expect(fromUnc('\\\\wsl.localhost\\Ubuntu\\home\\user\\meu-repo\\')).toEqual({ distro: 'Ubuntu', linux: '/home/user/meu-repo' })
  expect(fromUnc('\\\\wsl$\\Ubuntu\\home\\user')).toEqual({ distro: 'Ubuntu', linux: '/home/user' })
  expect(fromUnc('//wsl.localhost/Ubuntu')).toEqual({ distro: 'Ubuntu', linux: '/' })
  expect(fromUnc('C:/Users')).toBe(null)
  expect(toUnc('Ubuntu', '/home/user')).toBe('//wsl.localhost/Ubuntu/home/user')
  expect(linuxOf(wsl, `${wsl.root}/src/a.ts`)).toBe('/home/user/meu-repo/src/a.ts')
  expect(mntToWin('/mnt/c/Users/user')).toBe('C:/Users/user')
})

test('a path maps into the tree only from inside the repo', () => {
  expect(inRepo(wsl, '\\\\wsl.localhost\\Ubuntu\\home\\user\\meu-repo\\src\\a.ts')).toBe(`${wsl.root}/src/a.ts`)
  expect(inRepo(wsl, '\\\\wsl$\\ubuntu\\home\\user\\meu-repo')).toBe(wsl.root)
  expect(inRepo(wsl, '/home/user/meu-repo/x')).toBe(`${wsl.root}/x`)
  expect(inRepo(wsl, '/home/user/meu-repo-2/x')).toBe(null)
  expect(inRepo(wsl, 'C:\\Users\\user')).toBe(null)
  expect(inRepo(win, 'c:\\users\\user\\documents\\code\\outro\\a.md')).toBe(`${win.root}/a.md`)
  expect(inRepo(win, '/mnt/c/Users/user/Documents/Code/outro/b')).toBe(`${win.root}/b`)
  expect(inRepo(win, 'C:/Users/user/Documents/Code/outros/a')).toBe(null)
})

test('a command names the repo by Linux path, tilde, $HOME or UNC', () => {
  expect(mentions(wsl, 'wsl.exe -e sh -c "cd ~/meu-repo && git status"')).toBe(true)
  expect(mentions(wsl, 'wsl -e git -C /home/user/meu-repo log')).toBe(true)
  expect(mentions(wsl, 'cat \\\\wsl.localhost\\Ubuntu\\home\\user\\meu-repo\\a')).toBe(true)
  expect(mentions(wsl, 'cd $HOME/meu-repo')).toBe(true)
  expect(mentions(wsl, 'cd ~/meu-repo-old')).toBe(false)
  expect(mentions(win, 'git -C C:\\Users\\user\\Documents\\Code\\outro status')).toBe(true)
})

test('pane ids stay inside the engine alphabet and differ per repo', () => {
  const id = paneId(wsl.key)
  expect(/^[A-Za-z0-9_-]{1,64}$/.test(id)).toBe(true)
  expect(id.startsWith('rx-wsl-meu-repo-')).toBe(true)
  expect(paneId(win.key) === id).toBe(false)
  expect(titleOf(wsl)).toBe('WSL meu-repo')
  expect(titleOf(win)).toBe('outro')
})

test('a ~ path maps into a WSL repo under that home', () => {
  expect(inRepo(wsl, '~/meu-repo/a.md')).toBe(`${wsl.root}/a.md`)
  expect(inRepo(wsl, '~/meu-repo-2/a.md')).toBe(null)
  expect(inRepo(win, '~/meu-repo/a.md')).toBe(null)
})
