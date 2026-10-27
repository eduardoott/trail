# Trail

A Claude Code mod: a file tree tab for each git repo Claude works in, the session repo and outside ones (WSL included). The tab of the repo where Claude reads, edits or runs a command comes to the front by itself, and each touched file lights up in the tree: purple for reads, orange for edits, green for new files.

## What it does

- One tab per git repo. Claude's first edit in a repo opens its tab.
- The tab follows Claude: the repo being edited comes to the front.
- Trail: what Claude read and edited stays lit in the tree, with line counters.
- Replay: the buttons at the top of the tab replay the last turn, command by command.
- The `±` button keeps only changed files; the `Σ` button toggles the right column between date and size.
- Big folders open folded: only the files Claude touched, the ones changed in git and 3 neighbours of each are shown, the rest collapse into clickable "… N files" blocks, and the count in the header opens the whole folder.
- Card mode: instead of opening by itself, a card asks permission on the first write in an outside repo.

## Install

From this repo's marketplace:

```bash
claude plugin marketplace add eduardoott/trail
claude plugin install trail@trail
```

Or add the folder to your team's marketplace and install from there.

In the terminal, the tab needs the fullscreen layout (`/tui fullscreen`) and at least 110 columns. In the desktop app the tab opens on the side.

## Commands

```
/trail open <folder>          opens the tab of a repo
/trail close <root>           closes the tab of that repo
/trail forget <root | all>    forgets the permission given in the card
```

## Settings

In `/config`, plugin section:

| Setting | Key | Default | What it does |
|---|---|---|---|
| Tab follows Claude | `followTab` | on | the tab of the repo in use comes to the front by itself |
| Session repo tab | `sessionTab` | on | opens the session repo's tab at startup |
| Reads too | `reads` | yes | the tab also opens when Claude only reads |
| Icons | `glyphs` | auto | Nerd Font when one is installed, Unicode in the desktop app |
| Right column | `column` | date | last modified date or size |
| Diagnostic line | `diagnostics` | off | writes a grey line in the conversation on each tab switch |
| Replay animation | `replayAnimation` | modern | classic lights each command for 2 s |
| Live animation | `liveAnimation` | animated | the short version of the animation on each read or edit |
| How the tab opens | `opening` | auto | or `card`, which asks permission first |
| Big folder | `bigFolder` | 200 | a folder with more files than this opens folded, showing only the files Claude touched, the ones changed in git and 3 neighbours of each, the rest as clickable "… N files" blocks; the count in the header opens the whole folder; 0 turns it off |

## Tests

```bash
claude plugin validate .
claude plugin test .
```

## Credits

The tree starts from filetree 0.2.24 (Kurt Buhler, MIT) and the permission card follows Blast Radius (Anthropic, Apache-2.0). Details in [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md). MIT license in [LICENSE](LICENSE).
