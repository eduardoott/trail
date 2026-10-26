import { expect, test } from 'claude-code/testing'
import { insideSession, shellBlind, shellReads, shellWrites, writeTargets } from '../hooks/detect'

const HOME = 'C:/Users/user'
const SESSION = ['C:/Users/user/Documents/Code/projeto', 'C:/Users/user/Documents/Code/projeto']
const paths = (command: string, ps = false) => shellWrites(command, ps, HOME).map(t => `${t.wsl ? 'wsl' : 'win'} ${t.path}`)

test('Write, Edit and NotebookEdit name the file; Read names nothing', () => {
  expect(writeTargets({ tool: 'Write', file_path: 'C:\\Users\\user\\Downloads\\a.txt' }, HOME)).toEqual([{ path: 'C:/Users/user/Downloads/a.txt', wsl: false }])
  expect(writeTargets({ tool: 'Edit', file_path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\meu-repo\\a.sql' }, HOME)).toEqual([{ path: '//wsl.localhost/Ubuntu/home/user/meu-repo/a.sql', wsl: true }])
  expect(writeTargets({ tool: 'NotebookEdit', notebook_path: 'D:/x/n.ipynb' }, HOME)).toEqual([{ path: 'D:/x/n.ipynb', wsl: false }])
  expect(writeTargets({ tool: 'Read', file_path: 'C:/Users/user/Downloads/a.txt' }, HOME)).toEqual([])
})

test('shell writers: redirect, tee, cp, mv, rm, mkdir, touch, sed -i', () => {
  expect(paths('echo hi > C:/Users/user/Downloads/a.txt')).toEqual(['win C:/Users/user/Downloads/a.txt'])
  expect(paths('echo hi >> "C:\\Users\\user\\b.txt" 2>&1')).toEqual(['win C:/Users/user/b.txt'])
  expect(paths('ls 2>/dev/null')).toEqual([])
  expect(paths('cat a | tee /mnt/c/Users/user/x/log.txt')).toEqual(['win C:/Users/user/x/log.txt'])
  expect(paths('cp a.txt b.txt C:/Users/user/dest/')).toEqual(['win C:/Users/user/dest'])
  expect(paths('mv -f old /c/Users/user/new')).toEqual(['win C:/Users/user/new'])
  expect(paths('rm -rf ~/scratch/a ~/scratch/b')).toEqual(['win C:/Users/user/scratch/a', 'win C:/Users/user/scratch/b'])
  expect(paths('mkdir -p /home/user/scratch/novo && touch /home/user/scratch/novo/x')).toEqual(['wsl /home/user/scratch/novo', 'wsl /home/user/scratch/novo/x'])
  expect(paths("sed -i 's/a/b/' C:/r/f.txt")).toEqual(['win C:/r/f.txt'])
})

test('reads are ignored: cat, grep, sed -n, ls, head', () => {
  expect(paths('cat C:/Users/user/Downloads/a.txt')).toEqual([])
  expect(paths('grep -rn foo /home/user/meu-repo')).toEqual([])
  expect(paths("sed -n '1,20p' C:/r/f.txt && head C:/r/g.txt && ls C:/r")).toEqual([])
})

test('git counts in the folder it runs in: -C, or a cd before it', () => {
  expect(paths('git -C C:/Users/user/Documents/Code/outro status')).toEqual(['win C:/Users/user/Documents/Code/outro'])
  expect(paths('cd /c/Users/user/Documents/Code/outro && git commit -m x')).toEqual(['win C:/Users/user/Documents/Code/outro'])
  expect(paths('git status')).toEqual([])
})

test('wsl.exe: git -C, sh -c with cd inside, and a write inside the script', () => {
  expect(paths('wsl.exe -e git -C /home/user/meu-repo status')).toEqual(['wsl /home/user/meu-repo'])
  expect(paths('wsl -d Ubuntu -e sh -c "cd ~/meu-repo && git add -A"')).toEqual(['wsl ~/meu-repo'])
  expect(paths('wsl.exe bash -lc "cd ~/scratch/teste-trail-wsl && echo x >> notas.md"')).toEqual(['wsl ~/scratch/teste-trail-wsl/notas.md'])
  expect(paths('wsl.exe -e sh -c "cat ~/outro-repo/README.md"')).toEqual([])
})

test('PowerShell writers and its literal backslashes', () => {
  expect(paths('Set-Content -Path C:\\Users\\user\\Downloads\\a.txt -Value "oi"', true)).toEqual(['win C:/Users/user/Downloads/a.txt'])
  expect(paths('New-Item -ItemType Directory -Force C:\\tmp\\novo', true)).toEqual(['win C:/tmp/novo'])
  expect(paths('Copy-Item a.txt -Destination D:\\backup', true)).toEqual(['win D:/backup'])
  expect(paths('Get-Content C:\\x\\a.txt; Remove-Item C:\\x\\b.txt -Confirm:$false', true)).toEqual(['win C:/x/b.txt'])
  expect(paths('"oi" | Out-File C:\\x\\c.txt 2>$null', true)).toEqual(['win C:/x/c.txt'])
})

test('a folder inside the session is ignored; /mnt/c is the same Windows folder', () => {
  const [mnt] = shellWrites('touch /mnt/c/Users/user/Documents/Code/projeto/a.md', false, HOME)
  expect(mnt).toEqual({ path: 'C:/Users/user/Documents/Code/projeto/a.md', wsl: false })
  expect(insideSession(mnt!, SESSION)).toBe(true)
  expect(insideSession({ path: 'c:/users/user/documents/code/projeto', wsl: false }, SESSION)).toBe(true)
  expect(insideSession({ path: 'C:/Users/user/Documents/Code/projeto-2/a', wsl: false }, SESSION)).toBe(false)
  expect(insideSession({ path: '/home/user/meu-repo', wsl: true }, SESSION)).toBe(false)
})

test('with leitura on, Read, Grep and the shell readers count too', () => {
  const reads = (command: string, ps = false) => shellWrites(command, ps, HOME, false, true).map(t => t.path)
  expect(writeTargets({ tool: 'Read', file_path: 'C:/r/a.txt' }, HOME, true)).toEqual([{ path: 'C:/r/a.txt', wsl: false }])
  expect(writeTargets({ tool: 'Grep', pattern: 'x', path: 'D:\\y' }, HOME, true)).toEqual([{ path: 'D:/y', wsl: false }])
  expect(reads('cat C:/r/a.txt')).toEqual(['C:/r/a.txt'])
  expect(reads('grep -rn foo C:/r/src')).toEqual(['C:/r/src'])
  expect(reads("sed -n '1,5p' C:/r/f.txt")).toEqual(['C:/r/f.txt'])
  expect(reads('wsl.exe -e sh -c "cat ~/outro-repo/README.md"')).toEqual(['~/outro-repo/README.md'])
  expect(reads('Get-Content -Path C:\\r\\a.txt -Tail 5', true)).toEqual(['C:/r/a.txt'])
  expect(reads('Select-String -Pattern foo -Path C:\\r\\b.txt', true)).toEqual(['C:/r/b.txt'])
})

test('shellReads names what a command only reads, through wsl.exe and PowerShell too', () => {
  const reads = (command: string, ps = false) => shellReads(command, ps, HOME).map(t => t.path)
  expect(reads('wsl.exe -e sh -c "cat ~/meu-repo/wsl-only.md"')).toEqual(['~/meu-repo/wsl-only.md'])
  expect(reads('cat "C:/Users/user/x/a.md" > C:/tmp/out.txt')).toEqual(['C:/Users/user/x/a.md'])
  expect(reads('Get-Content -Path C:/x/a.txt', true)).toEqual(['C:/x/a.txt'])
  expect(reads('echo oi > C:/x/b.txt')).toEqual([])
})

test('a write through a variable or a glob names its folder and how deep it lands; an rm marks its targets gone', () => {
  const blind = (command: string, ps = false, cwd: string | null = null) => shellBlind(command, ps, HOME, cwd).map(b => `${b.path} ${b.depth}`)
  expect(blind('cd /c/r/play && mkdir -p lote && for i in 01 02; do echo "x $i" > lote/novo-$i.txt; done')).toEqual(['C:/r/play/lote 1'])
  expect(blind('rm C:/r/lote/*.txt')).toEqual(['C:/r/lote 1'])
  expect(blind('for f in a b; do rm "$f"; done', false, 'C:/r')).toEqual(['C:/r 4'])
  expect(blind('Set-Content -Path "C:\\r\\lote\\$name.txt" -Value x', true)).toEqual(['C:/r/lote 1'])
  expect(blind('rm -r ~/tmp/$d/sub/*.log')).toEqual(['C:/Users/user/tmp 4'])
  expect(blind('echo x > C:/r/a.txt; cat $f; ls 2>$null')).toEqual([])
  const gone = (command: string, ps = false) => shellWrites(command, ps, HOME).filter(t => t.gone).map(t => t.path)
  expect(gone('rm C:/r/a.txt C:/r/b.txt && touch C:/r/c.txt')).toEqual(['C:/r/a.txt', 'C:/r/b.txt'])
  expect(gone('Remove-Item C:\\r\\a.txt', true)).toEqual(['C:/r/a.txt'])
  expect(gone('rm C:/r/a.txt; echo x > C:/r/a.txt')).toEqual([])
})
