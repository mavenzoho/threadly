<p align="center">
  <img src="icon-large.png" alt="Threadly" width="180" />
</p>

<h1 align="center">Threadly</h1>

<p align="center">
  <strong>Group your AI chats and the files that go with them — right in the VS Code sidebar.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=tarekali.threadly">Marketplace</a> ·
  <a href="https://github.com/mavenzoho/threadly/issues">Issues</a> ·
  <a href="#privacy">Privacy</a>
</p>

---

If you live in Claude, Codex, Copilot, Cursor or Cline, you know the problem: by the end of a project you have 8 chat tabs open, 14 file tabs, and no way to tell which goes with what. Switch tasks and the context is gone.

Threadly fixes that. Make a Thread per task. Drop chats and files into it. One click reopens the *exact* chat — not just the chat panel.

---

## Features

- **Group anything in your sidebar.** Files, folders, and AI chat threads — bundled per task.
- **Reopen the exact chat.** Click a saved chat → jumps straight to that conversation. Not "open the chat panel" — *that* thread.
- **Bulk import in one click.** Snapshot every open tab into a Thread, including chats.
- **Browse past chats.** Surface your entire chat history for the current project from disk — multi-select to add to a Thread.
- **Color-code your Threads.** 8 theme-aware colors so the auth Thread looks different from the mobile Thread at a glance.
- **Reorder freely.** Drag Threads around. Move Up / Move Down from the right-click menu.
- **Inline-ish rename.** `F2` on a selected Thread, prefilled with live validation.
- **Drag entries between Threads.** Moved the wrong way? Drag it where it belongs.
- **Persistent per workspace.** Survives restarts. Each project has its own Threads, colors, and order.

Sits next to the native **Open Editors** panel — doesn't replace it, doesn't fight it.

---

## Why you want this

You're 40 minutes into refactoring auth. You have:

- 3 Claude chats (one debugging the migration, one drafting the new endpoint, one reviewing tests)
- 6 files open across two folders
- A doc tab with the spec

Then your boss pings — *"can you quickly look at the dashboard bug?"*

Without Threadly: close everything, lose your place, rebuild context tomorrow.

With Threadly: create a Thread called **Auth Refactor**, bulk-import, switch context. Tomorrow morning → right-click the Thread → **Open All** → you're back exactly where you left off, chats and all.

---

## Quick start

1. Install from the marketplace
2. Open the **Explorer** sidebar (`Ctrl+Shift+E` / `Cmd+Shift+E`)
3. Find the **Threadly** panel
4. Click the **new folder** icon → name your first Thread
5. Click the **cloud-download** icon → bulk-import every tab you currently have open
6. Click any saved chat → jumps back to that exact Claude/Codex session

Or click the **history** icon to browse every past chat for this project — even ones not currently open.

---

## Threadly stores pointers, not conversations

> *"Local state survives Anthropic UI changes. Pointer doesn't. Which way did you build it?"* — fair question.

**Pointer.** Threadly stores session IDs and URIs, not the conversation content. Anthropic's own `~/.claude/projects/*.jsonl` files are the source of truth. Snapshotting inside Threadly would diverge instantly the moment you continue a chat, and Anthropic's local files survive their UI changes anyway.

**Tradeoff**: if Anthropic renames a command or changes their URI scheme, Threadly's reopen logic breaks. That logic is ~50 lines and would be a one-patch fix.

**Upside**: if you uninstall Threadly tomorrow, you lose zero conversation data. The chats stay with Claude. Worst case = you re-create your Threads.

---

## How it works (the technical bit)

VS Code's extension API doesn't expose AI chat session IDs to other extensions. Threadly extracts them by:

1. **For Claude** — reading your workspace's `state.vscdb` SQLite file, where VS Code persists each webview tab's session ID alongside its title
2. **For Codex** — using its `openai-codex:` URI scheme, which already carries the session ID
3. **For past chats** — scanning `~/.claude/projects/<slug>/*.jsonl` directly to surface sessions that aren't currently open

Each click then dispatches the right command (`claude-vscode.editor.open` for Claude, `vscode.openWith` for Codex) with the saved session ID.

---

## Supported AI extensions

| Extension | Tabs imported | Reopens exact thread |
|---|---|---|
| Claude Code (Anthropic) | ✅ | ✅ |
| Codex (OpenAI) | ✅ | ✅ |
| GitHub Copilot Chat | ✅ | 🚧 planned |
| Cursor | ✅ | 🚧 planned |
| Cline | ✅ | 🚧 planned |
| Continue | ✅ | 🚧 planned |

If you want first-class support for an extension not listed, open an issue with the extension's name and viewType — usually a 1-day add.

---

## Known limitations

- **After window reload, clicking a still-open Claude chat may open a duplicate tab.** This is a Claude extension limitation — its in-memory panel registry resets on reload. The conversation is the same; you just get two tabs pointing at it.
- **Multi-window**: if you have the same workspace open in two VS Code windows, the reopen target window isn't predictable.
- **Closed sessions** reopen from disk. If you've deleted a Claude/Codex session locally, the bookmark falls back to opening the chat panel.

---

## Privacy

Threadly reads two things, **both local to your machine**:

1. Your workspace's VS Code state database (`state.vscdb`) — to learn which chat tabs map to which session IDs
2. Your AI tool's session files (`~/.claude/projects/*.jsonl`, `~/.codex/`, etc.) — only when you explicitly run **Browse Past Chats**

**No network calls. No telemetry. No analytics. No accounts.** Threadly cannot phone home — there's no server.

The full source is in this repo. `grep -rn "fetch\|http" src/` returns nothing because Threadly doesn't reach out to anything.

---

## Roadmap

- Copilot Chat / Cursor / Cline thread reopening (same trick, different extensions)
- Export a Thread as a shareable JSON file (workflow templates)
- "Last accessed" timestamp on Threads
- Auto-suggest a Thread when you open files near each other
- "Snooze" a Thread (collapse for a week, then resurface)

Have a feature in mind? [Open an issue.](https://github.com/mavenzoho/threadly/issues)

---

## Building from source

```bash
git clone https://github.com/mavenzoho/threadly.git
cd threadly
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host with Threadly loaded.

To package a `.vsix` for local install:

```bash
npx @vscode/vsce package
code --install-extension threadly-*.vsix
```

---

## Changelog

See [GitHub Releases](https://github.com/mavenzoho/threadly/releases).

---

## License

[MIT](LICENSE) — fork it, ship it, sell it, just keep the copyright notice.
