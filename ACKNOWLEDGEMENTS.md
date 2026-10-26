# Acknowledgements

## filetree 0.2.24, Kurt Buhler, MIT

`hooks/register.tsx`, `hooks/tree.ts`, `hooks/git.ts`, `hooks/rows.tsx`, `hooks/icons.ts` and `hooks/open.ts` start from filetree 0.2.24, under the MIT License in [LICENSE](LICENSE).

Changes from the original:

- One tab per git repo instead of one tree.
- WSL repos run git through `wsl.exe`.
- The header shows the whole path.
- Reads lit purple through `wsl.exe`, PowerShell and quoted Windows paths too.
- Long lists on the desktop scroll in a window instead of passing the 100,000 character bound.
- A `±` button keeps only the changed files.

## Blast Radius 0.1.0, Anthropic, Apache-2.0

The access card in `hooks/card.tsx` and the way `hooks/register.tsx` holds a tool call follow the Blast Radius hold. The hold waits through short `$.process.run` pauses, so it is not bound by the hook budget.

No Blast Radius code is copied. Source: https://github.com/anthropics/claude-code-playground, folder `claude-code/mods/blast-radius`, commit 569c528 (01/10/2026), Apache License 2.0.
