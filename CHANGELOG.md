# Changelog

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
