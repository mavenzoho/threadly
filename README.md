<p align="center">
  <img src="icon-large.png" alt="Threadly" width="180" />
</p>

<h1 align="center">Threadly</h1>

<p align="center">
  <strong>Group your AI threads and the files that go with them — right in the VS Code sidebar.</strong>
</p>

---

If you live in Claude, Copilot, Cursor or Cline chats, you already know the problem: by the end of a project you have 8 chat tabs open, 14 file tabs, and no way to tell which goes with what. Switch tasks and you lose all context.

Threadly fixes that. Make a group per task. Drop chats and files into it. One click reopens the exact chat — not just the chat panel.

---

## What it does

- **Group anything in your sidebar.** Files, folders, and AI chat threads — bundled per task or feature.
- **Reopen the exact chat.** Click a saved chat to jump straight to that session in Claude. Not "open the chat panel" — *that* conversation.
- **Bulk import in one click.** Snapshot every open tab into a group, including chats.
- **Persistent per workspace.** Survives restarts. Each project has its own groups.
- **Drag between groups.** Moved the wrong way? Drag the file or chat to where it belongs.

Sits next to the native **Open Editors** panel — doesn't replace it, doesn't fight it.

---

## Why you want this

You're 40 minutes into refactoring auth. You have:

- 3 Claude chats (one debugging the migration, one drafting the new endpoint, one reviewing your tests)
- 6 files open across two folders
- A doc tab with the spec

Then your boss pings — *"can you quickly look at the dashboard bug?"*

Without Threadly: you close everything, lose your place, take 20 minutes to rebuild context tomorrow.

With Threadly: you create a group called **Auth Refactor**, drag everything in, switch context, and tomorrow morning you right-click the group → **Open All** → you're back exactly where you left off, chats and all.

---

## Quick start

1. Install from the marketplace
2. Open the **Explorer** sidebar (`Ctrl+Shift+E` / `Cmd+Shift+E`)
3. Find the **Threadly** panel
4. Click the **new folder** icon → name your first group
5. Click the **cloud-download** icon → bulk-import every tab you currently have open
6. Click a chat in the group to jump back to that exact Claude session

---

## How it works (the magic bit)

VS Code's extension API doesn't expose chat session IDs to other extensions. Threadly works around this by reading your workspace's VS Code state database directly — that's where each chat tab's session ID is stored — and matches it back to the tab. The result: clicking a chat bookmark opens *that specific past conversation*, not a new one.

This is the part most "tab grouping" extensions can't do.

---

## Supported AI extensions

| Extension | Files | Chats | Reopen exact thread |
|---|---|---|---|
| Claude Code (Anthropic) | ✅ | ✅ | ✅ |
| GitHub Copilot Chat | ✅ | ✅ | 🚧 coming soon |
| Cursor | ✅ | ✅ | 🚧 coming soon |
| Cline | ✅ | ✅ | 🚧 coming soon |
| Continue | ✅ | ✅ | 🚧 coming soon |

If you want first-class support for an extension not on this list, open an issue.

---

## Known limitations

- **After window reload, clicking a still-open chat may open a duplicate tab.** This is a Claude extension limitation — its panel registry resets on reload. The chat itself is the same; just two tabs now point at it.
- **Chat thread reopening only works in single-window setups today.** If you have the same workspace open in two VS Code windows, the session might open in the wrong one.
- **Closed chat sessions are reopened from disk.** Claude must still have the session locally for the click to land somewhere.

---

## Privacy

Threadly reads your local VS Code workspace state file (`state.vscdb`) to extract chat session IDs from currently-open tabs. **No data leaves your machine.** No telemetry, no analytics, no calls home.

---

## Roadmap

- Copilot Chat / Cursor / Cline thread reopening
- "Search past chats" — your VS Code remembers every chat across every workspace; surface them
- Export a group as a shareable JSON file (workflow templates)
- Group icons & color tags
- Auto-suggest a group when you open files near each other

---

## Building from source

```bash
git clone <repo>
cd threadly
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

---

## License

MIT
