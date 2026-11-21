# Changelog

## 0.2.1

- Fewer duplicate fetches. Up to four repos are fetched at once, so a repo can wait in the queue while another Repo
  Board window, the VS Code extension or git on the command line fetches it. Repo Board now checks again right before
  the fetch starts and skips it if the repo was just fetched, showing the new state instead.

## 0.2.0

- **Know how fresh "behind" is.** Every tile says when its repo was last fetched (*fetched 20m ago*) and turns it
  into a warning after a day or when it never happened. Fetches by any tool count: git on the command line, VS Code or
  the Repo Board extension. A **not fetched recently** chip lists those repos, and the switcher flags them too.
- **Background fetch.** Repo Board fetches every 30 minutes by default (Settings › *Fetch in the background every*;
  0 turns it off) and skips repos something else fetched recently. Background fetches now update `FETCH_HEAD`, so
  other tools see them.
- **Fetch failures are visible.** A repo whose fetch fails shows *fetch failed* with the reason instead of quietly
  keeping old numbers. When every fetch fails, the board shows one *Offline* note instead.
- **Stashes don't get lost.** The stash badge says *2 stashes* and gives the oldest one's age; click it to list each
  stash with its branch, message and age. A **with stashes** chip finds them, *most changes* ranks stashed repos above
  clean ones, and worktree tiles no longer repeat their main repo's stashes.
- **Check for updates** (in the **⋯** menu) points to the releases page. The app now contains a signed auto-updater,
  which will be switched on in a later version.
- macOS builds are ad-hoc signed, which should replace the "damaged" message with the usual first-launch prompt.

Install 0.2.0 over 0.1.0 by downloading it below; your board and settings are kept.

## 0.1.0

The first release of Repo Board as a standalone desktop app for Windows, macOS and Linux, built with Tauri. It has
every feature of the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-repoboard)
that doesn't depend on VS Code itself.

- **The same board as the extension:** fleet strip, filter chips (with changes, behind, ahead, unavailable), grid and
  list views, collections, pins, tags, icons, colours, drag and drop, fuzzy search with `#tags`, and every keyboard
  shortcut.
- **Shared data:** the app and the extension read and write the same `catalog.json`, and changes made in one appear
  in the other live.
- **Auto-discovery** of every repo under your scan folders, with linked worktrees grouped under their main repo.
- **Real git status** on every tile, a language bar and project logos. *Fetch all* and *Pull all* (fast-forward
  only, four at a time) run across every repo.
- **Open with your editor:** VS Code, VS Code Insiders, Cursor, Windsurf, VSCodium, Zed, Sublime Text, IntelliJ IDEA
  or a custom command. `.code-workspace` projects open as workspaces in VS Code-family editors.
- **Open a terminal** with Windows Terminal, PowerShell, Command Prompt, Terminal, iTerm, GNOME Terminal, Konsole,
  xterm or a custom command.
- **Project switcher** (<kbd>Ctrl</kbd>+<kbd>P</kbd>), plus a configurable global shortcut
  (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) that brings the app forward with the switcher open.
- **In-app settings**, a setup guide, a log viewer, a tray icon with quick actions, optional close-to-tray, a single
  instance, and a remembered window size and position.
- **Safe by design:** every git command line is fixed in the Rust core, background git never prompts or runs hooks,
  pulls are `--ff-only`, and credentials are stripped from remote links.

### Known limitations

- The builds are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper show a warning on first launch.
  See the README.
- macOS and Linux builds compile and pass their tests in CI, but launching editors and terminals and picking up
  `PATH` have only been exercised on Windows so far. The tray menu has not been exercised on any OS yet. Please
  report anything that doesn't work.
- On macOS, an unsigned app downloaded from the internet may be reported as "damaged". Run
  `xattr -dr com.apple.quarantine "/Applications/Repo Board.app"` once to open it.
- Scan folders and other settings are not shared with the VS Code extension. Only the board itself (`catalog.json`)
  is.
