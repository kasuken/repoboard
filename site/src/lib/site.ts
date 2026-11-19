/** Joins a path onto the configured base so links work on GitHub Pages (/repoboard/) and on a custom domain (/). */
export function url(path = ''): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const clean = path.replace(/^\//, '');
  return clean ? `${base}/${clean}` : `${base}/`;
}

/** Absolute URL, for canonical links, Open Graph and structured data. */
export function absolute(path = ''): string {
  return new URL(url(path), import.meta.env.SITE).href;
}

export const links = {
  repo: 'https://github.com/kasuken/repoboard',
  releases: 'https://github.com/kasuken/repoboard/releases/latest',
  issues: 'https://github.com/kasuken/repoboard/issues',
  changelog: 'https://github.com/kasuken/repoboard/blob/main/CHANGELOG.md',
  sponsor: 'https://github.com/sponsors/kasuken',
  extension: 'https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-repoboard',
  extensionRepo: 'https://github.com/kasuken/vscode-repoboard',
};

export const meta = {
  name: 'Repo Board',
  title: 'Repo Board: every git repo on your machine, on one board',
  description:
    'Free desktop app and VS Code extension that finds every git repository on your disk and shows which ones have uncommitted changes, commits to pull or push, and conflicts. Fetch or pull them all in one click. Windows, macOS and Linux.',
};

export const faqs: { q: string; a: string }[] = [
  {
    q: 'Is Repo Board free?',
    a: 'Yes. The desktop app and the VS Code extension are free and open source under the MIT license. There is no account and nothing to sign up for.',
  },
  {
    q: 'Does it scan my whole disk?',
    a: 'No. It only walks the scan folders you choose, to the depth you set (three levels by default), and stops at each repository it finds. It never follows symlinks or junctions and skips node_modules and similar folders.',
  },
  {
    q: 'Can I use the desktop app and the VS Code extension together?',
    a: 'Yes. Both read and write the same catalog.json, so pins, collections, tags and the order of your repos are shared, and a change made in one shows up in the other while both are running.',
  },
  {
    q: 'Does Repo Board send my data anywhere?',
    a: 'No. There is no telemetry, no account and no cloud service. The only network traffic is git talking to your own remotes, and the app asking GitHub whether a newer version exists.',
  },
  {
    q: 'Can Pull all break my branches?',
    a: 'Every pull is fast-forward only (git pull --ff-only), so it never creates a merge commit. Repos with conflicts are skipped, and there is no push-all button.',
  },
  {
    q: 'Which editors and terminals does it open?',
    a: 'VS Code, VS Code Insiders, Cursor, Windsurf, VSCodium, Zed, Sublime Text and IntelliJ IDEA, plus Windows Terminal, PowerShell, Terminal, iTerm, GNOME Terminal and Konsole. Anything else works through a custom command.',
  },
  {
    q: 'Why does Windows or macOS warn me when I install it?',
    a: 'The builds are not code-signed yet. On Windows, choose More info, then Run anyway. On macOS, if the app is reported as damaged, run xattr -dr com.apple.quarantine "/Applications/Repo Board.app" once.',
  },
  {
    q: 'What do I need installed?',
    a: 'Only git on your PATH. Repo Board runs on Windows, macOS (Apple silicon and Intel) and Linux (AppImage, .deb or .rpm).',
  },
];
