<p align="center">
  <img src="images/logo.png" width="128" alt="Repo Board logo">
</p>

<h1 align="center">Repo Board</h1>

<p align="center">
  <b>Every git repo on your machine, on one board.</b><br>
  A standalone, cross-platform desktop app for Windows, macOS and Linux. See which repos are dirty, behind or ahead at a glance, and open any of them in your editor or terminal.
</p>

<p align="center">
  <a href="https://github.com/kasuken/repoboard/releases/latest"><b>Download</b></a>
  &nbsp;·&nbsp;
  <a href="https://kasuken.github.io/repoboard/">Website</a>
  &nbsp;·&nbsp;
  <a href="#quick-start">Quick start</a>
  &nbsp;·&nbsp;
  <a href="#keyboard-shortcuts">Shortcuts</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/kasuken/repoboard/issues">Report an issue</a>
</p>

![Repo Board showing pinned repos, collections and the git state of every repo](images/hero.png)

Repo Board started as a [VS Code extension](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-repoboard).
Many users asked for it outside the editor, so this is the same board as a desktop app built with [Tauri](https://tauri.app).
It works with any editor, and if you also use the extension, **both show the same board**.

## Why Repo Board

If you have more than a handful of repos, you know the routine. You `cd` around to remember which one has uncommitted
work, forget to pull before starting, and scroll through your editor's recent list hoping the project is still there.

Repo Board replaces that with one window:

- **It finds your repos for you.** Point it at `C:\code` or `~/src` once. Every repository underneath appears, and new
  clones show up by themselves.
- **It tells you where attention is needed.** Uncommitted changes, commits to pull or push, merge conflicts, stashes
  and missing folders, for every repo, without opening any of them.
- **It gets you there fast.** A fuzzy switcher (also available from anywhere with a global shortcut), a keyboard-driven
  board, and one click to open a repo in your editor, a terminal in it, or its page on GitHub, GitLab or Azure DevOps.
- **It keeps everything up to date in one go.** *Fetch all* and *Pull all* run across every repo, four at a time,
  fast-forward only.

## Features

### The whole fleet at a glance

The strip at the top has one cell per repo, coloured by its git state. The chips under it filter the board to what
matters right now: repos **with changes** (including edits in their worktrees), **behind**, **to push**, **with stashes**,
**unavailable** or **not fetched recently**. Sort by *most changes* and the
repos that need you come first.

![Repos with uncommitted changes, sorted by most changes](images/attention.png)

| Colour | Meaning |
| --- | --- |
| Yellow / tan | Uncommitted changes (staged, modified or untracked) |
| Amber | Behind its upstream: there is something to pull |
| Blue | Ahead of its upstream: there is something to push |
| Red | Merge conflicts |
| Green | Clean and in sync |
| Hatched | Folder deleted, or the drive or share is not connected |

### Real git status on every tile

Each tile shows the branch, ahead/behind counts, how many files are staged, modified, untracked or conflicted, the
stash count, the last commit and when it happened, a GitHub-style language bar, and the project's own logo if it has
one. Fetch, pull and push buttons appear when there is something to do.

Most of this comes from a single `git status --porcelain=v2` call per repo. The board is shown instantly from cache
while fresh status streams in.

### Know how fresh "behind" is

A behind count is only as current as the last `git fetch`. Every tile says when its repo was last fetched, such as
*fetched 20m ago*, and turns it into a warning once that is more than a day ago or never happened. The time comes from
the repo itself, so fetches from the command line, VS Code or the Repo Board extension count too.

Repo Board also fetches in the background, every 30 minutes by default, and skips any repo that something else fetched
recently. If a fetch fails, for example because a token expired, the tile says *fetch failed* and why, instead of
quietly showing old numbers. When the network is down, the board shows one *Offline* note instead of an error on every
repo.

### Nothing left unpushed

**To push** finds every repo with commits that only exist on this machine. A branch that is ahead of its upstream shows
how many commits to push. A branch that was never pushed says *3 not pushed* instead of a vague "local only", and a
repo with no remote at all says *no remote*. Other local branches with unpushed commits get a *2 branches to push*
badge; click it to see which branches and how many commits each.

### Stashes don't get lost

Stashes never show up as changed files, so a repo whose only unsaved work is a stash looks clean. Repo Board shows a
*2 stashes* badge on the tile, with the age of the oldest in its tooltip. Click it to list each stash with its branch,
message and age. The **with stashes** chip finds them all, and *most changes* ranks stashed repos above clean ones.

![A repo's stashes listed with their branch, message and age](images/stashes.png)

### Auto-discovery

Add one or more **scan folders**, and Repo Board walks them (three levels deep by default). It stops at each `.git`,
never follows symlinks or junctions, and skips `node_modules` and friends. Repos you remove from the board stay
removed, even if they are still on disk.

### Worktrees stay with their repo

Linked `git worktree` folders, such as the ones coding agents create for each task, don't crowd the board.
They appear as a badge on their main repo's tile. The badge turns yellow when one of them has uncommitted
work, and that repo counts as having changes: it shows up under **with changes** and in *most changes*, even when
the main checkout itself is clean. Click it to see each worktree's branch and change count, then open it, open a terminal there or reveal
it. Prefer every worktree as a project of its own? Switch **Worktrees** to *separate* in Settings.

![A repo tile with its worktrees listed](images/worktrees.png)

### A switcher that knows your repos

Press <kbd>Ctrl</kbd>+<kbd>P</kbd> (<kbd>Cmd</kbd>+<kbd>P</kbd> on macOS) in the app, or the global shortcut
<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> from anywhere. Type a few letters of a name, a path, a
branch, a collection or a `#tag`. Pinned projects come first, then the ones you opened most recently.

![The project switcher filtered to "pay"](images/switcher.png)

### Search that understands developers

The board search is fuzzy on names (`chkweb` finds `checkout-web`) and also matches paths, descriptions, branches,
languages and collections. Start a word with `#` to filter by tag, and combine terms: `#acme pay`.

![Search filtered to the #acme tag](images/search.png)

### Organise as much or as little as you like

Pin favourites to the top. Group repos into coloured **collections**. Add **tags**, an emoji or short icon, and a
description. Sort by last opened, name, last commit or most changes, or pick *My order* and drag tiles and collections
wherever you want them. Switch between the grid and a dense list.

Pins go stale as your focus moves. A pinned repo you haven't opened for two weeks says *not opened in 3 weeks*
with an **Unpin** button, and the Pinned header offers to unpin all of them at once. Change the number of days in
Settings, or set it to 0 to turn this off.

![Edit a project: name, description, icon, collection, colour and tags](images/edit.png)

![List view in the light theme](images/list-light.png)

### Works with your editor and terminal

Open a repo in **VS Code, VS Code Insiders, Cursor, Windsurf, VSCodium, Zed, Sublime Text** or any command you
configure, in the same or a new window. Open a terminal there with **Windows Terminal, PowerShell, Terminal, iTerm,
GNOME Terminal, Konsole** or your own command. Reveal it in Explorer, Finder or your file manager, copy its path, or
open its remote in the browser.

![Context menu on a repo tile](images/menu.png)

### Lives in your tray

Repo Board puts an icon in the system tray with *Switch project*, *Fetch all*, *Pull all* and *Scan*. Turn on
**Close to tray** in Settings to keep it running in the background.

### Updates

For now, install new versions from the [releases page](https://github.com/kasuken/repoboard/releases): **⋯ › Check for
updates** takes you there. The app already contains a signed auto-updater, which will check GitHub at start-up and
install new versions once update signing is set up for this repository.

## Quick start

1. Download the installer for your system from the [latest release](https://github.com/kasuken/repoboard/releases/latest):
   - **Windows:** `.msi` or `-setup.exe`
   - **macOS:** `.dmg` (`aarch64` for Apple silicon, `x64` for Intel)
   - **Linux:** `.AppImage`, `.deb` or `.rpm`
2. Start Repo Board and choose **Scan a folder for repos**. Pick the folders that hold your repos.
3. Open **Settings** (<kbd>Ctrl</kbd>+<kbd>,</kbd>) to choose your editor and terminal.
4. From now on, press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> anywhere to jump to a repo.

> **The builds are not code-signed yet.** On Windows, SmartScreen may say "Windows protected your PC": choose
> *More info* › *Run anyway*. On macOS, if the app is reported as "damaged" or
> blocked, run `xattr -dr com.apple.quarantine "/Applications/Repo Board.app"` once.

Repo Board needs [git](https://git-scm.com) on your `PATH`.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Bring Repo Board forward with the switcher open, from anywhere (configurable) |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> / <kbd>Ctrl</kbd>+<kbd>K</kbd> | Switch project |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Settings |
| <kbd>/</kbd> | Search the board |
| Arrow keys, <kbd>Home</kbd>, <kbd>End</kbd> | Move between repos |
| <kbd>Enter</kbd> / <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Open in your editor / open in the other kind of window |
| <kbd>T</kbd> | Open a terminal in the repo |
| <kbd>B</kbd> | Open the remote in the browser |
| <kbd>F</kbd> / <kbd>R</kbd> | Fetch / refresh status |
| <kbd>P</kbd> / <kbd>E</kbd> | Pin / edit details |
| <kbd>Del</kbd> | Remove from the board |
| <kbd>Esc</kbd> | Clear the search |
| <kbd>?</kbd> | Show all shortcuts |

![Keyboard shortcuts dialog](images/help.png)

On macOS use <kbd>Cmd</kbd> instead of <kbd>Ctrl</kbd>.

## Settings

Everything is configured in the app (**⋯ › Settings**, or <kbd>Ctrl</kbd>+<kbd>,</kbd>):

![The Settings dialog](images/settings.png)

| Setting | Default | Description |
| --- | --- | --- |
| Scan folders | none | Folders scanned for git repositories. `~` works. |
| Scan depth | `3` | Folder levels searched below each scan folder (1–8) |
| Auto scan | on | Re-scan when the app starts or comes back to the front, at most every 10 minutes |
| Worktrees | `nested` | `nested` shows linked worktrees inside their main repo; `separate` gives each its own tile |
| Ignored folders | `node_modules`, `bin`, `obj`, `dist`, … | Folder names skipped by discovery and language detection |
| Editor | VS Code | Editor used to open projects, or a custom command with `{path}` |
| Open in new window | on | Open projects in a new editor window by default |
| Terminal | automatic | Terminal used by *Open terminal here*, or a custom command with `{path}` |
| Global shortcut | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Brings the app forward with the switcher open; empty turns it off |
| Default view / sort | grid / recent | How the board starts |
| Fetch at start-up | on | `git fetch` when the app starts and when you refresh the board, skipping repos fetched in the last 10 minutes |
| Stale pins | 14 days | Pinned repos not opened for this long are marked so you can unpin them; 0 turns it off |
| Background fetch | every 30 minutes | Keeps ahead/behind current; repos fetched recently by any tool are skipped; 0 turns it off |
| Cache minutes | `5` | How long git status is reused before it is read again |
| Language bar | on | Bounded file scan per project, capped at *Max files scanned* (10 000) |
| Theme | system | System, light or dark |
| Close to tray | off | Closing the window keeps Repo Board running in the tray |

## Privacy and safety

- **No telemetry, no account, no cloud.** The only network traffic is git talking to your own remotes (and, once
  automatic updates are switched on, a daily download of `latest.json` from this repository's releases).
- **Background git never prompts.** Status reads and background fetches disable terminal prompts, Git Credential
  Manager dialogs and askpass helpers. They never take the index lock, and run with repository hooks and
  `core.fsmonitor` turned off. Fetch, pull and push that you start yourself run like your own git, hooks included.
- **The UI can't run arbitrary commands.** Every git command line is fixed in the app's Rust core; the board can only
  ask for status, fetch, pull (`--ff-only`) or push.
- **Pull never merges.** Every pull is `--ff-only`. Bulk pull skips repos with conflicts. There is no "push all".
- **Credentials never leak into links.** Remote URLs such as `https://user:token@host/…` are always stripped before
  they are shown or opened.
- **Your data is readable JSON.** The board lives in `catalog.json`, in the same folder the VS Code extension uses:
  `%APPDATA%\repoboard` on Windows, `~/Library/Application Support/repoboard` on macOS and `$XDG_CONFIG_HOME/repoboard`
  (default `~/.config/repoboard`) on Linux. App settings and the status cache are kept in the app's own folder. Writes
  are atomic, and a damaged file is kept as a backup instead of being overwritten.

## FAQ

**Can I use it together with the VS Code extension?**
Yes. Both read and write the same `catalog.json`, so pins, collections, tags and the order of your repos are shared,
and changes made in one show up in the other live. Scan folders and other settings are configured separately.

**Does it scan my whole disk?**
No. It only walks the scan folders you choose, to the depth you set, and stops at each repository it finds.

**A repo shows "Git refuses this repo (dubious ownership)". What now?**
Git doesn't trust a folder owned by another user. Run the command shown on the tile
(`git config --global --add safe.directory <path>`) and refresh.

**My editor isn't listed.**
Choose *Custom command* in Settings and enter its command line, for example `idea64.exe {path}` or
`nvim-qt {path}`. The command runs directly, never through a shell.

## Build from source

You need [Node.js](https://nodejs.org) 22+, [Rust](https://rustup.rs) and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/kasuken/repoboard.git
cd repoboard
npm install
npm run tauri dev     # run the app with hot reload
npm test              # TypeScript unit tests
npm run tauri build   # build installers into src-tauri/target/release/bundle
```

`npm run dev` alone serves the UI in a normal browser at `http://localhost:1420` with a fake backend and sample repos,
which is handy for UI work. Set `REPOBOARD_DATA_DIR` to a scratch folder to keep test runs away from your real board.

### Releasing

Pushing a tag such as `v0.2.0` builds every installer and publishes the release.
Keep the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` in sync, and add a
`CHANGELOG.md` section for it: that section becomes the release notes.

Automatic updates need a signing key. To switch them on (one-time setup):

```bash
npx tauri signer generate -w ~/.tauri/repoboard.key
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/repoboard.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # the password you chose, or press Enter for none
```

Then put the contents of `~/.tauri/repoboard.key.pub` in `plugins.updater.pubkey` and set
`bundle.createUpdaterArtifacts` to `true` in `src-tauri/tauri.conf.json`. Releases then include `latest.json` and
signed update bundles, and the builds check for updates by themselves. Keep the private key safe: installed apps only
accept updates signed with it.

## Credits

- Icons: [Codicons](https://github.com/microsoft/vscode-codicons) by Microsoft, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Built with [Tauri](https://tauri.app).

## Support

If Repo Board saves you time, star the [repository](https://github.com/kasuken/repoboard) or
[sponsor the work](https://github.com/sponsors/kasuken). It really helps.

Released under the [MIT license](LICENSE).
