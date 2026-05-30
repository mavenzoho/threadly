import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

type Entry =
  | { kind: 'file'; uri: string; viewType?: string; label?: string }
  | { kind: 'chat'; label: string; viewType: string; sessionId?: string };

type GroupsState = Record<string, Entry[]>;
type ColorsState = Record<string, string>;

const STATE_KEY = 'editorGroups.groups.v2';
const ORDER_KEY = 'editorGroups.order.v1';
const COLORS_KEY = 'editorGroups.colors.v1';
const LEGACY_KEY = 'editorGroups.groups';

const THREAD_COLORS = [
  { name: 'Default', themeColor: undefined as string | undefined },
  { name: 'Red', themeColor: 'charts.red' },
  { name: 'Orange', themeColor: 'charts.orange' },
  { name: 'Yellow', themeColor: 'charts.yellow' },
  { name: 'Green', themeColor: 'charts.green' },
  { name: 'Blue', themeColor: 'charts.blue' },
  { name: 'Purple', themeColor: 'charts.purple' },
  { name: 'Pink', themeColor: 'terminal.ansiMagenta' },
] as const;

function extractUri(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputNotebook) return input.uri;
  if (input instanceof vscode.TabInputNotebookDiff) return input.modified;
  return undefined;
}

function extractViewType(input: unknown): string | undefined {
  if (input instanceof vscode.TabInputCustom) return input.viewType;
  if (input instanceof vscode.TabInputWebview) return input.viewType;
  return undefined;
}

const AI_CUSTOM_EDITOR_VIEWTYPES: { match: RegExp; renderer: 'chat'; tool: string }[] = [
  { match: /chatgpt\.conversationEditor/i, renderer: 'chat', tool: 'codex' },
];

function isAICustomEditor(input: unknown): boolean {
  if (!(input instanceof vscode.TabInputCustom)) return false;
  return AI_CUSTOM_EDITOR_VIEWTYPES.some((r) => r.match.test(input.viewType));
}

function isChatWebview(input: unknown): input is vscode.TabInputWebview {
  if (!(input instanceof vscode.TabInputWebview)) return false;
  const vt = input.viewType.toLowerCase();
  return (
    vt.includes('claudevscodepanel') ||
    vt.includes('claude') ||
    vt.includes('chat') ||
    vt.includes('copilot') ||
    vt.includes('continue') ||
    vt.includes('cline') ||
    vt.includes('cody') ||
    vt.includes('cursor')
  );
}

function entryKey(e: Entry): string {
  if (e.kind === 'file') return `file:${e.uri}`;
  if (e.sessionId) return `chat:${e.sessionId}`;
  return `chat:${e.viewType}:${e.label}`;
}

function getCodeUserDir(): string | undefined {
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Code', 'User'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Code - Insiders', 'User'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User'),
    path.join(os.homedir(), '.config', 'Code', 'User'),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p));
}

function findWorkspaceStorageDir(): string | undefined {
  const userDir = getCodeUserDir();
  if (!userDir) return undefined;
  const storageRoot = path.join(userDir, 'workspaceStorage');
  if (!fs.existsSync(storageRoot)) return undefined;
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) return undefined;
  const targetUri = wsFolder.uri.toString();
  try {
    for (const entry of fs.readdirSync(storageRoot)) {
      const wsJson = path.join(storageRoot, entry, 'workspace.json');
      try {
        const data = JSON.parse(fs.readFileSync(wsJson, 'utf8'));
        const stored = (data.folder || data.workspace || '') as string;
        if (stored === targetUri) return path.join(storageRoot, entry);
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return undefined;
}

type SessionLookup = {
  byTitle: Map<string, string>;
  diagnostics: string[];
};

let lookupCache: SessionLookup | undefined;
let lookupCacheStamp = 0;

function parseChatStatesFromBlob(raw: string): { title: string; sessionId: string }[] {
  const out: { title: string; sessionId: string }[] = [];
  // The blob stores escaped-twice JSON: titles appear as \"title\":\"...\" (1 backslash)
  // and sessionID lives inside a string-encoded inner state object as \\\"sessionID\\\":\\\"uuid\\\" (3 backslashes).
  // Match any number of backslashes around the quote to be safe.
  const sidRe = /\\*"sessionID\\*":\\*"([0-9a-f-]{36})\\*"/gi;
  let m: RegExpExecArray | null;
  while ((m = sidRe.exec(raw)) !== null) {
    const sid = m[1];
    const before = raw.slice(Math.max(0, m.index - 4000), m.index);
    // title is escaped once: \"title\":\"...escaped chars...\"
    // Titles look like: \"title\":\"Some text\\\" with escaped quotes\"
    // The closing \" is preceded by a non-backslash. Capture lazily, then validate.
    const titleMatches = [...before.matchAll(/\\"title\\":\\"((?:\\\\.|[^\\])*?)\\"/g)];
    if (titleMatches.length === 0) continue;
    const last = titleMatches[titleMatches.length - 1];
    try {
      // Captured chars are outer-JSON-escaped. Unescape \\" -> ", \\\\ -> \\, etc.
      const cleaned = last[1].replace(/\\(.)/g, '$1');
      out.push({ title: cleaned, sessionId: sid });
    } catch {
      // skip
    }
  }
  return out;
}

async function loadSessionLookup(): Promise<SessionLookup> {
  const STALE_MS = 3000;
  const now = Date.now();
  if (lookupCache && now - lookupCacheStamp < STALE_MS) return lookupCache;

  const diagnostics: string[] = [];
  const byTitle = new Map<string, string>();

  const userDir = getCodeUserDir();
  diagnostics.push(`userDir: ${userDir ?? 'NOT FOUND'}`);

  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  diagnostics.push(`workspaceFolder: ${wsFolder?.uri.toString() ?? 'NONE'}`);

  const wsDir = findWorkspaceStorageDir();
  diagnostics.push(`workspaceStorageDir: ${wsDir ?? 'NOT FOUND (will scan all)'}`);

  // Collect candidate db paths: matched dir first, then ALL workspaceStorage dirs as fallback
  const dbCandidates: string[] = [];
  if (wsDir) {
    const p = path.join(wsDir, 'state.vscdb');
    if (fs.existsSync(p)) dbCandidates.push(p);
  }
  if (userDir) {
    const storageRoot = path.join(userDir, 'workspaceStorage');
    if (fs.existsSync(storageRoot)) {
      for (const entry of fs.readdirSync(storageRoot)) {
        const p = path.join(storageRoot, entry, 'state.vscdb');
        if (fs.existsSync(p) && !dbCandidates.includes(p)) dbCandidates.push(p);
      }
    }
  }
  diagnostics.push(`db candidates: ${dbCandidates.length}`);

  if (dbCandidates.length === 0) {
    const result = { byTitle, diagnostics };
    lookupCache = result;
    lookupCacheStamp = now;
    return result;
  }

  let SQL: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js');
    // sql.js blocks './package.json' in its exports field. Resolve via the main entry instead.
    const sqlJsMain = require.resolve('sql.js');
    // .../sql.js/dist/sql-wasm.js  →  .../sql.js/dist/sql-wasm.wasm
    let wasmPath = path.join(path.dirname(sqlJsMain), 'sql-wasm.wasm');
    if (!fs.existsSync(wasmPath)) {
      // Fallback: walk up to package root and try dist/
      const pkgRoot = path.resolve(path.dirname(sqlJsMain), '..');
      wasmPath = path.join(pkgRoot, 'dist', 'sql-wasm.wasm');
    }
    diagnostics.push(`wasm exists: ${fs.existsSync(wasmPath)} (${wasmPath})`);
    SQL = await initSqlJs({ locateFile: () => wasmPath });
  } catch (e) {
    diagnostics.push(`sql.js init failed: ${(e as Error).message}`);
    const result = { byTitle, diagnostics };
    lookupCache = result;
    lookupCacheStamp = now;
    return result;
  }

  let dbsScanned = 0;
  let blobsFound = 0;
  for (const dbPath of dbCandidates) {
    try {
      const fileBuf = fs.readFileSync(dbPath);
      const db = new SQL.Database(fileBuf);
      const res = db.exec(
        "SELECT value FROM ItemTable WHERE key = 'memento/workbench.parts.editor'",
      );
      const raw = res?.[0]?.values?.[0]?.[0];
      db.close();
      dbsScanned++;
      if (typeof raw !== 'string') continue;
      blobsFound++;
      const pairs = parseChatStatesFromBlob(raw);
      for (const { title, sessionId } of pairs) {
        if (!byTitle.has(title)) byTitle.set(title, sessionId);
      }
    } catch (e) {
      diagnostics.push(`db error (${path.basename(path.dirname(dbPath))}): ${(e as Error).message}`);
    }
  }
  diagnostics.push(`dbs scanned: ${dbsScanned}, blobs found: ${blobsFound}, titles mapped: ${byTitle.size}`);

  const result = { byTitle, diagnostics };
  lookupCache = result;
  lookupCacheStamp = now;
  return result;
}

async function loadChatSessionMap(): Promise<Map<string, string>> {
  return (await loadSessionLookup()).byTitle;
}

type HistoryItem = {
  sessionId: string;
  title: string;
  tool: 'claude' | 'codex';
  mtimeMs: number;
  relativeTime: string;
  uri?: string;
};

function relativeTimeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function claudeProjectDirName(workspacePath: string): string {
  // Claude's actual scheme: replace EACH non-alphanumeric char with a single `-`, do NOT collapse,
  // preserve original case. Drive letter gets lowercased but only via the leading char rule.
  // Examples observed on disk:
  //   "d:\erpnbox"         -> "d--erpnbox"          (drive letter is already lowercase here)
  //   "D:\New folder (2)"  -> "d--New-folder--2-"   (D->d, rest preserved)
  const replaced = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
  // Lowercase only the first alphabetic char (drive letter), keep rest as-is
  return replaced.length > 0 ? replaced[0].toLowerCase() + replaced.slice(1) : '';
}

async function collectChatHistory(workspacePath: string): Promise<HistoryItem[]> {
  const items: HistoryItem[] = [];

  // 1) Claude sessions: ~/.claude/projects/<slug>/*.jsonl
  try {
    const claudeRoot = path.join(os.homedir(), '.claude', 'projects');
    if (fs.existsSync(claudeRoot)) {
      const wantedSlug = claudeProjectDirName(workspacePath);
      let projectDir: string | undefined;
      // Exact match first
      const exactPath = path.join(claudeRoot, wantedSlug);
      if (fs.existsSync(exactPath)) {
        projectDir = exactPath;
      } else {
        // Case-insensitive fallback
        const wantedLower = wantedSlug.toLowerCase();
        for (const entry of fs.readdirSync(claudeRoot)) {
          if (entry.toLowerCase() === wantedLower) {
            projectDir = path.join(claudeRoot, entry);
            break;
          }
        }
      }
      if (projectDir && fs.existsSync(projectDir)) {
        for (const f of fs.readdirSync(projectDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const sessionId = f.slice(0, -6);
          const fp = path.join(projectDir, f);
          try {
            const stat = fs.statSync(fp);
            // Grab first user message text or first ~120 chars for title
            let title = sessionId.slice(0, 8);
            const text = fs.readFileSync(fp, 'utf8').slice(0, 8000);
            const m = text.match(/"role"\s*:\s*"user"[\s\S]{0,500}?"content"\s*:\s*"((?:[^"\\]|\\.){5,200})"/);
            if (m) {
              try {
                title = JSON.parse('"' + m[1] + '"').replace(/\s+/g, ' ').trim().slice(0, 80);
              } catch {
                // ignore
              }
            } else {
              const tm = text.match(/"content"\s*:\s*\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.){5,200})"/);
              if (tm) {
                try {
                  title = JSON.parse('"' + tm[1] + '"').replace(/\s+/g, ' ').trim().slice(0, 80);
                } catch {
                  // ignore
                }
              }
            }
            items.push({
              sessionId,
              title,
              tool: 'claude',
              mtimeMs: stat.mtimeMs,
              relativeTime: relativeTimeAgo(stat.mtimeMs),
            });
          } catch {
            // skip
          }
        }
      }
    }
  } catch {
    // skip
  }

  // 2) Codex sessions: ~/.codex/sessions/<year>/<month>/<day>/rollout-<ts>-<uuid>.jsonl
  // Each file's first line is a session_meta object with id + cwd + timestamp.
  try {
    const codexSessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    if (fs.existsSync(codexSessionsRoot)) {
      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      const wantedCwd = normalize(workspacePath);
      const walk = (dir: string, depth: number) => {
        if (depth > 5) return;
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(p, depth + 1);
            continue;
          }
          if (!(e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))) continue;
          try {
            const stat = fs.statSync(p);
            const buf = Buffer.alloc(Math.min(stat.size, 4096));
            const fd = fs.openSync(p, 'r');
            try {
              fs.readSync(fd, buf, 0, buf.length, 0);
            } finally {
              fs.closeSync(fd);
            }
            const firstLine = buf.toString('utf8').split('\n')[0];
            let meta: any;
            try {
              meta = JSON.parse(firstLine);
            } catch {
              continue;
            }
            if (meta?.type !== 'session_meta' || !meta?.payload) continue;
            const payload = meta.payload;
            const sessionId = payload.id;
            if (typeof sessionId !== 'string') continue;

            // Filter by workspace: keep only sessions whose cwd matches the current folder
            const cwd = typeof payload.cwd === 'string' ? normalize(payload.cwd) : '';
            if (cwd && cwd !== wantedCwd && !cwd.startsWith(wantedCwd) && !wantedCwd.startsWith(cwd)) {
              continue;
            }

              // Title: try a few places. Best effort.
              let title = sessionId.slice(0, 8);
              if (typeof payload.title === 'string' && payload.title.trim()) {
                title = payload.title.trim().slice(0, 80);
              } else {
                // Codex stores user messages as JSON objects with role:user and content[].text/input_text.
                // The first few user messages are framework boilerplate (environment_context, app-context,
                // permissions instructions). Skip those and grab the first real user prompt.
                const text = fs.readFileSync(p, 'utf8').slice(0, 60000);
                const userRegex = /"role"\s*:\s*"user"[\s\S]{0,2000}?"(?:text|input_text)"\s*:\s*"((?:[^"\\]|\\.){2,400})"/g;
                let m: RegExpExecArray | null;
                while ((m = userRegex.exec(text)) !== null) {
                  let candidate = '';
                  try {
                    candidate = JSON.parse('"' + m[1] + '"');
                  } catch {
                    continue;
                  }
                  const trimmed = candidate.trim();
                  if (!trimmed) continue;
                  if (/^<(environment_context|app-context|permissions|user-instructions)/i.test(trimmed)) continue;
                  if (trimmed.startsWith('<') && trimmed.endsWith('>')) continue;
                  title = trimmed.replace(/\s+/g, ' ').slice(0, 80);
                  break;
                }
              }

            items.push({
              sessionId,
              title,
              tool: 'codex',
              mtimeMs: stat.mtimeMs,
              relativeTime: relativeTimeAgo(stat.mtimeMs),
              uri: `openai-codex:/${sessionId}`,
            });
          } catch {
            // skip
          }
        }
      };
      walk(codexSessionsRoot, 0);
    }
  } catch {
    // skip
  }

  // Newest first
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

function fuzzyMatchTitle(tabLabel: string, byTitle: Map<string, string>): string | undefined {
  // Direct hit
  if (byTitle.has(tabLabel)) return byTitle.get(tabLabel);
  // VS Code may truncate the tab label with … (U+2026) while state has the full title — or vice versa.
  // Strip trailing ellipsis chars and compare prefixes.
  const norm = (s: string) => s.replace(/[….]+$/u, '').trim();
  const tabNorm = norm(tabLabel);
  if (!tabNorm) return undefined;
  for (const [k, v] of byTitle) {
    const kNorm = norm(k);
    if (kNorm === tabNorm) return v;
    if (kNorm.startsWith(tabNorm) || tabNorm.startsWith(kNorm)) return v;
  }
  return undefined;
}

function chatOpenCommand(viewType: string): { command: string; args?: unknown[] } {
  const vt = viewType.toLowerCase();
  if (vt.includes('claude')) return { command: 'workbench.action.chat.open' };
  if (vt.includes('copilot')) return { command: 'workbench.action.chat.open' };
  return { command: 'workbench.action.chat.open' };
}

class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    count: number,
    public readonly themeColor?: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'group';
    this.iconPath = new vscode.ThemeIcon(
      'organization',
      themeColor ? new vscode.ThemeColor(themeColor) : undefined,
    );
    this.description = `${count}`;
  }
}

class FileItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly groupName: string,
    public readonly viewType?: string,
    storedLabel?: string,
  ) {
    const isAIScheme = uri.scheme === 'openai-codex' || uri.scheme === 'cursor';
    const displayLabel =
      storedLabel || (isAIScheme ? uri.path.replace(/^\/+/, '') || 'Codex chat' : path.basename(uri.fsPath));
    super(displayLabel, vscode.TreeItemCollapsibleState.None);

    if (isAIScheme) {
      this.contextValue = 'chat';
      this.iconPath = new vscode.ThemeIcon('comment-discussion');
      this.description = 'Codex';
      this.tooltip = `Codex chat\n${uri.toString()}`;
    } else {
      this.contextValue = 'file';
      this.resourceUri = uri;
      this.tooltip = uri.fsPath;
      this.description = vscode.workspace.asRelativePath(path.dirname(uri.fsPath));
    }

    this.command = viewType
      ? {
          command: 'vscode.openWith',
          title: 'Open',
          arguments: [uri, viewType, { preserveFocus: false, preview: false }],
        }
      : {
          command: 'vscode.open',
          title: 'Open',
          arguments: [uri],
        };
  }
}

class ChatItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly viewType: string,
    public readonly groupName: string,
    public readonly sessionId?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'chat';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.description = sessionId ? '' : 'chat (no id)';
    this.tooltip = sessionId
      ? `Chat: ${label}\nsessionId: ${sessionId}\nClick to reopen this exact chat.`
      : `Chat: ${label}\nNo session id captured — click opens the Claude panel.`;
    this.command = {
      command: 'editorGroups.openChat',
      title: 'Open Chat',
      arguments: [{ sessionId, viewType }],
    };
  }
}

type Node = GroupItem | FileItem | ChatItem;

type DragPayload =
  | { kind: 'entry'; entry: Entry; from: string }
  | { kind: 'group'; name: string };

class EditorGroupsProvider
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>
{
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  readonly dropMimeTypes = ['application/vnd.code.tree.threadly'];
  readonly dragMimeTypes = ['application/vnd.code.tree.threadly'];

  constructor(private context: vscode.ExtensionContext) {
    this.migrateLegacy();
  }

  private migrateLegacy() {
    const v2 = this.context.workspaceState.get<GroupsState>(STATE_KEY);
    if (v2) return;
    const legacy = this.context.workspaceState.get<Record<string, string[]>>(LEGACY_KEY);
    if (!legacy) return;
    const migrated: GroupsState = {};
    for (const [name, uris] of Object.entries(legacy)) {
      migrated[name] = uris.map((u) => ({ kind: 'file' as const, uri: u }));
    }
    this.context.workspaceState.update(STATE_KEY, migrated);
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getGroups(): GroupsState {
    return this.context.workspaceState.get<GroupsState>(STATE_KEY, {});
  }

  getOrder(): string[] {
    const stored = this.context.workspaceState.get<string[]>(ORDER_KEY, []);
    const groups = this.getGroups();
    const keys = new Set(Object.keys(groups));
    const ordered = stored.filter((n) => keys.has(n));
    for (const k of Object.keys(groups).sort()) {
      if (!ordered.includes(k)) ordered.push(k);
    }
    return ordered;
  }

  async setOrder(order: string[]): Promise<void> {
    await this.context.workspaceState.update(ORDER_KEY, order);
    this.refresh();
  }

  getColors(): ColorsState {
    return this.context.workspaceState.get<ColorsState>(COLORS_KEY, {});
  }

  async setColor(name: string, themeColor: string | undefined): Promise<void> {
    const colors = this.getColors();
    if (themeColor) colors[name] = themeColor;
    else delete colors[name];
    await this.context.workspaceState.update(COLORS_KEY, colors);
    this.refresh();
  }

  async setGroups(groups: GroupsState): Promise<void> {
    await this.context.workspaceState.update(STATE_KEY, groups);
    this.refresh();
  }

  async renameGroup(oldName: string, newName: string): Promise<boolean> {
    if (!newName || newName === oldName) return false;
    const groups = this.getGroups();
    if (groups[newName]) return false;
    const newGroups: GroupsState = {};
    const order = this.getOrder();
    for (const n of order) {
      const target = n === oldName ? newName : n;
      newGroups[target] = groups[n];
    }
    const newOrder = order.map((n) => (n === oldName ? newName : n));
    const colors = this.getColors();
    if (colors[oldName]) {
      colors[newName] = colors[oldName];
      delete colors[oldName];
    }
    await this.context.workspaceState.update(STATE_KEY, newGroups);
    await this.context.workspaceState.update(ORDER_KEY, newOrder);
    await this.context.workspaceState.update(COLORS_KEY, colors);
    this.refresh();
    return true;
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    const groups = this.getGroups();
    if (!element) {
      const colors = this.getColors();
      return this.getOrder().map((n) => new GroupItem(n, groups[n].length, colors[n]));
    }
    if (element instanceof GroupItem) {
      return (groups[element.name] || []).map((e) => {
        if (e.kind === 'file')
          return new FileItem(vscode.Uri.parse(e.uri), element.name, e.viewType, e.label);
        return new ChatItem(e.label, e.viewType, element.name, e.sessionId);
      });
    }
    return [];
  }

  async handleDrag(source: Node[], dataTransfer: vscode.DataTransfer): Promise<void> {
    const payload: DragPayload[] = [];
    for (const s of source) {
      if (s instanceof FileItem) {
        payload.push({
          kind: 'entry',
          entry: {
            kind: 'file',
            uri: s.uri.toString(),
            viewType: s.viewType,
            label: typeof s.label === 'string' ? s.label : undefined,
          },
          from: s.groupName,
        });
      } else if (s instanceof ChatItem) {
        payload.push({
          kind: 'entry',
          entry: { kind: 'chat', label: s.label, viewType: s.viewType, sessionId: s.sessionId },
          from: s.groupName,
        });
      } else if (s instanceof GroupItem) {
        payload.push({ kind: 'group', name: s.name });
      }
    }
    if (payload.length === 0) return;
    dataTransfer.set(
      'application/vnd.code.tree.threadly',
      new vscode.DataTransferItem(payload),
    );
  }

  async handleDrop(target: Node | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get('application/vnd.code.tree.threadly');
    if (!item) return;
    const payload = item.value as DragPayload[];
    if (!payload?.length) return;

    const groupDrags = payload.filter((p): p is Extract<DragPayload, { kind: 'group' }> => p.kind === 'group');
    const entryDrags = payload.filter((p): p is Extract<DragPayload, { kind: 'entry' }> => p.kind === 'entry');

    // Reorder groups: dragging a group onto another group (or before/after)
    if (groupDrags.length > 0) {
      let targetName: string | undefined;
      if (target instanceof GroupItem) targetName = target.name;
      else if (target instanceof FileItem || target instanceof ChatItem) targetName = target.groupName;
      // If no target (dropped on empty area), append to end
      const order = this.getOrder();
      const movingNames = new Set(groupDrags.map((g) => g.name));
      const remaining = order.filter((n) => !movingNames.has(n));
      let insertAt = targetName ? remaining.indexOf(targetName) : remaining.length;
      if (insertAt < 0) insertAt = remaining.length;
      const moved = groupDrags.map((g) => g.name).filter((n) => order.includes(n));
      remaining.splice(insertAt, 0, ...moved);
      await this.setOrder(remaining);
    }

    // Move entries between groups
    if (entryDrags.length > 0) {
      let targetGroup: string | undefined;
      if (target instanceof GroupItem) targetGroup = target.name;
      else if (target instanceof FileItem || target instanceof ChatItem) targetGroup = target.groupName;
      if (!targetGroup) return;
      const groups = this.getGroups();
      for (const { entry, from } of entryDrags) {
        if (from === targetGroup) continue;
        const k = entryKey(entry);
        groups[from] = (groups[from] || []).filter((e) => entryKey(e) !== k);
        if (!groups[targetGroup]) groups[targetGroup] = [];
        if (!groups[targetGroup].some((e) => entryKey(e) === k)) groups[targetGroup].push(entry);
      }
      await this.setGroups(groups);
    }
  }
}

async function pickGroup(
  provider: EditorGroupsProvider,
  placeholder: string,
  allowNew = true,
): Promise<string | undefined> {
  const groups = provider.getGroups();
  const names = provider.getOrder();
  const items: vscode.QuickPickItem[] = names.map((n) => ({
    label: n,
    description: `${groups[n].length} items`,
  }));
  if (allowNew) {
    items.unshift({ label: '$(new-folder) New Thread...', description: 'Create a new Thread' });
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
  if (!picked) return undefined;
  if (picked.label.startsWith('$(new-folder)')) {
    const name = await vscode.window.showInputBox({ prompt: 'Thread name' });
    if (!name) return undefined;
    if (!groups[name]) {
      groups[name] = [];
      await provider.setGroups(groups);
    }
    return name;
  }
  return picked.label;
}

function addEntry(groups: GroupsState, groupName: string, entry: Entry): boolean {
  if (!groups[groupName]) groups[groupName] = [];
  const k = entryKey(entry);
  if (groups[groupName].some((e) => entryKey(e) === k)) return false;
  groups[groupName].push(entry);
  return true;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new EditorGroupsProvider(context);

  const treeView = vscode.window.createTreeView('threadly', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: provider,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('editorGroups.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('editorGroups.debugSessionLookup', async () => {
      lookupCache = undefined;
      const lookup = await loadSessionLookup();
      const tabs: string[] = [];
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          if (tab.input instanceof vscode.TabInputWebview) {
            const matched = fuzzyMatchTitle(tab.label, lookup.byTitle);
            tabs.push(
              `[webview viewType=${tab.input.viewType}] "${tab.label}" → ${matched ?? 'NO MATCH'}`,
            );
          }
        }
      }
      const out = [
        '=== DIAGNOSTICS ===',
        ...lookup.diagnostics,
        '',
        '=== TITLE → SESSION ID MAP (' + lookup.byTitle.size + ' entries) ===',
        ...[...lookup.byTitle.entries()].map(([t, s]) => `"${t}" → ${s}`),
        '',
        '=== OPEN CHAT-LIKE TABS ===',
        ...tabs,
      ].join('\n');
      const doc = await vscode.workspace.openTextDocument({
        content: out,
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('editorGroups.debugListTabs', async () => {
      const lines: string[] = [];
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input;
          let kind = 'unknown';
          let detail = '';
          if (input instanceof vscode.TabInputText) {
            kind = 'TabInputText';
            detail = input.uri.toString();
          } else if (input instanceof vscode.TabInputTextDiff) {
            kind = 'TabInputTextDiff';
            detail = input.modified.toString();
          } else if (input instanceof vscode.TabInputCustom) {
            kind = 'TabInputCustom';
            detail = `${input.viewType} :: ${input.uri.toString()}`;
          } else if (input instanceof vscode.TabInputNotebook) {
            kind = 'TabInputNotebook';
            detail = input.uri.toString();
          } else if (input instanceof vscode.TabInputWebview) {
            kind = 'TabInputWebview';
            detail = `viewType=${input.viewType}`;
          } else if (input instanceof vscode.TabInputTerminal) {
            kind = 'TabInputTerminal';
          } else if (input === undefined) {
            kind = 'undefined (empty editor)';
          } else {
            kind = (input as object).constructor?.name ?? 'unknown';
          }
          lines.push(`[${kind}] "${tab.label}" — ${detail}`);
        }
      }
      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n') || '(no tabs found)',
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('editorGroups.createGroup', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'New Thread name' });
      if (!name) return;
      const groups = provider.getGroups();
      if (groups[name]) {
        vscode.window.showWarningMessage(`Thread "${name}" already exists.`);
        return;
      }
      groups[name] = [];
      await provider.setGroups(groups);
    }),

    vscode.commands.registerCommand('editorGroups.renameGroup', async (item?: GroupItem) => {
      // Fallback: if invoked via keybinding without a tree-item arg, use the selected node
      let target = item;
      if (!target) {
        const sel = treeView.selection.find((n) => n instanceof GroupItem) as GroupItem | undefined;
        if (!sel) {
          vscode.window.showInformationMessage('Select a Thread first.');
          return;
        }
        target = sel;
      }
      const newName = await vscode.window.showInputBox({
        prompt: `Rename "${target.name}"`,
        value: target.name,
        valueSelection: [0, target.name.length],
        validateInput: (v) => {
          if (!v.trim()) return 'Name cannot be empty';
          if (v === target!.name) return null;
          if (provider.getGroups()[v]) return `Thread "${v}" already exists`;
          return null;
        },
      });
      if (!newName) return;
      await provider.renameGroup(target.name, newName.trim());
    }),

    vscode.commands.registerCommand('editorGroups.deleteGroup', async (item: GroupItem) => {
      const confirm = await vscode.window.showWarningMessage(
        `Delete Thread "${item.name}"? (Files & chat tabs stay open.)`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      const groups = provider.getGroups();
      delete groups[item.name];
      const order = provider.getOrder().filter((n) => n !== item.name);
      await context.workspaceState.update(ORDER_KEY, order);
      await provider.setGroups(groups);
    }),

    vscode.commands.registerCommand('editorGroups.moveGroupUp', async (item: GroupItem) => {
      const order = provider.getOrder();
      const i = order.indexOf(item.name);
      if (i <= 0) return;
      [order[i - 1], order[i]] = [order[i], order[i - 1]];
      await provider.setOrder(order);
    }),

    vscode.commands.registerCommand('editorGroups.moveGroupDown', async (item: GroupItem) => {
      const order = provider.getOrder();
      const i = order.indexOf(item.name);
      if (i < 0 || i >= order.length - 1) return;
      [order[i + 1], order[i]] = [order[i], order[i + 1]];
      await provider.setOrder(order);
    }),

    vscode.commands.registerCommand('editorGroups.setColor', async (item?: GroupItem) => {
      let target = item;
      if (!target) {
        const sel = treeView.selection.find((n) => n instanceof GroupItem) as GroupItem | undefined;
        if (!sel) {
          vscode.window.showInformationMessage('Select a Thread first.');
          return;
        }
        target = sel;
      }
      const picked = await vscode.window.showQuickPick(
        THREAD_COLORS.map((c) => ({
          label: c.themeColor
            ? `$(circle-filled) ${c.name}`
            : `$(circle-outline) ${c.name}`,
          description: c.themeColor ?? 'no color',
          themeColor: c.themeColor,
        })),
        { placeHolder: `Pick a color for "${target.name}"` },
      );
      if (!picked) return;
      await provider.setColor(target.name, picked.themeColor);
    }),

    vscode.commands.registerCommand('editorGroups.browseChatHistory', async () => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        vscode.window.showInformationMessage('No workspace folder open.');
        return;
      }
      const items = await collectChatHistory(wsFolder.uri.fsPath);
      if (items.length === 0) {
        vscode.window.showInformationMessage(
          'No past chats found for this workspace. (Looked in ~/.claude/projects)',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        items.map((it) => ({
          label: `$(${it.tool === 'codex' ? 'rocket' : 'comment-discussion'}) ${it.title}`,
          description: `${it.tool} · ${it.relativeTime}`,
          detail: it.sessionId.slice(0, 8),
          payload: it,
        })),
        {
          placeHolder: `Found ${items.length} past chats — pick one (or many) to add to a Thread`,
          canPickMany: true,
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!picked || picked.length === 0) return;
      const group = await pickGroup(provider, 'Add selected chats to which Thread?');
      if (!group) return;
      const groups = provider.getGroups();
      let added = 0;
      for (const p of picked) {
        const it = p.payload;
        const entry: Entry =
          it.tool === 'codex'
            ? {
                kind: 'file',
                uri: it.uri!,
                viewType: 'chatgpt.conversationEditor',
                label: it.title,
              }
            : {
                kind: 'chat',
                label: it.title,
                viewType: 'mainThreadWebview-claudeVSCodePanel',
                sessionId: it.sessionId,
              };
        if (addEntry(groups, group, entry)) added++;
      }
      await provider.setGroups(groups);
      vscode.window.showInformationMessage(
        `Added ${added} past chat${added === 1 ? '' : 's'} to "${group}".`,
      );
    }),

    vscode.commands.registerCommand('editorGroups.addCurrentFile', async () => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!activeTab) {
        vscode.window.showInformationMessage('No active tab.');
        return;
      }
      const uri = extractUri(activeTab.input);
      let entry: Entry | undefined;
      if (uri) {
        const viewType = extractViewType(activeTab.input);
        entry = {
          kind: 'file',
          uri: uri.toString(),
          viewType: isAICustomEditor(activeTab.input) ? viewType : undefined,
          label: isAICustomEditor(activeTab.input) ? activeTab.label : undefined,
        };
      } else if (isChatWebview(activeTab.input)) {
        const titleMap = await loadChatSessionMap();
        entry = {
          kind: 'chat',
          label: activeTab.label,
          viewType: (activeTab.input as vscode.TabInputWebview).viewType,
          sessionId: fuzzyMatchTitle(activeTab.label, titleMap),
        };
      } else {
        vscode.window.showInformationMessage(
          'Active tab is not a file or recognized chat — cannot bookmark.',
        );
        return;
      }
      const group = await pickGroup(provider, 'Add to which Thread?');
      if (!group) return;
      const groups = provider.getGroups();
      addEntry(groups, group, entry);
      await provider.setGroups(groups);
    }),

    vscode.commands.registerCommand('editorGroups.addFileToGroup', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      const group = await pickGroup(provider, 'Add to which Thread?');
      if (!group) return;
      const groups = provider.getGroups();
      addEntry(groups, group, { kind: 'file', uri: target.toString() });
      await provider.setGroups(groups);
    }),

    vscode.commands.registerCommand(
      'editorGroups.importAllOpenEditors',
      async (item?: GroupItem) => {
        const group =
          item?.name ?? (await pickGroup(provider, 'Import open tabs into which Thread?'));
        if (!group) return;
        const groups = provider.getGroups();
        if (!groups[group]) groups[group] = [];

        let addedFiles = 0;
        let addedChats = 0;
        let skipped = 0;
        const titleMap = await loadChatSessionMap();

        for (const tabGroup of vscode.window.tabGroups.all) {
          for (const tab of tabGroup.tabs) {
            const uri = extractUri(tab.input);
            if (uri) {
              const vt = extractViewType(tab.input);
              const isAI = isAICustomEditor(tab.input);
              if (
                addEntry(groups, group, {
                  kind: 'file',
                  uri: uri.toString(),
                  viewType: isAI ? vt : undefined,
                  label: isAI ? tab.label : undefined,
                })
              ) {
                if (isAI) addedChats++;
                else addedFiles++;
              }
              continue;
            }
            if (isChatWebview(tab.input)) {
              const vt = (tab.input as vscode.TabInputWebview).viewType;
              const sessionId = fuzzyMatchTitle(tab.label, titleMap);
              if (
                addEntry(groups, group, {
                  kind: 'chat',
                  label: tab.label,
                  viewType: vt,
                  sessionId,
                })
              )
                addedChats++;
              continue;
            }
            skipped++;
          }
        }
        await provider.setGroups(groups);

        const parts: string[] = [];
        if (addedFiles) parts.push(`${addedFiles} file${addedFiles === 1 ? '' : 's'}`);
        if (addedChats) parts.push(`${addedChats} chat${addedChats === 1 ? '' : 's'}`);
        const headline = parts.length
          ? `Added ${parts.join(' + ')} to "${group}".`
          : `Nothing added to "${group}".`;
        const tail = skipped > 0 ? ` Skipped ${skipped} unsupported tab${skipped === 1 ? '' : 's'}.` : '';
        vscode.window.showInformationMessage(headline + tail);
      },
    ),

    vscode.commands.registerCommand(
      'editorGroups.openChat',
      async (arg: { sessionId?: string; viewType?: string }) => {
        const vt = (arg?.viewType || '').toLowerCase();
        const sid = arg?.sessionId;

        // Claude's createPanel() reveals an existing panel if its in-memory sessionPanels map
        // has the sessionId. After a window reload the map is empty even though the tab is restored,
        // so it creates a fresh panel — which is why you sometimes see "opens new tab" duplicates.
        // VS Code's public API has no way to focus an arbitrary webview tab from another extension.
        if (sid && vt.includes('claude')) {
          try {
            await vscode.commands.executeCommand('claude-vscode.editor.open', sid);
            return;
          } catch (e) {
            vscode.window.showWarningMessage(
              `Couldn't open chat by id. Falling back to opening the chat panel. (${(e as Error).message})`,
            );
          }
        }
        // Fallback
        try {
          if (vt.includes('claude')) {
            await vscode.commands.executeCommand('claude-vscode.editor.openLast');
          } else {
            await vscode.commands.executeCommand('workbench.action.chat.open');
          }
        } catch {
          await vscode.commands.executeCommand('workbench.action.chat.open');
        }
      },
    ),

    vscode.commands.registerCommand(
      'editorGroups.removeFromGroup',
      async (item: FileItem | ChatItem) => {
        const groups = provider.getGroups();
        const key =
          item instanceof FileItem
            ? entryKey({ kind: 'file', uri: item.uri.toString() })
            : entryKey({
                kind: 'chat',
                label: item.label,
                viewType: item.viewType,
                sessionId: item.sessionId,
              });
        groups[item.groupName] = (groups[item.groupName] || []).filter(
          (e) => entryKey(e) !== key,
        );
        await provider.setGroups(groups);
      },
    ),

    vscode.commands.registerCommand('editorGroups.openGroup', async (item: GroupItem) => {
      const groups = provider.getGroups();
      let opened = 0;
      let chatSkipped = 0;
      for (const entry of groups[item.name] || []) {
        if (entry.kind === 'file') {
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
            await vscode.window.showTextDocument(doc, { preview: false });
            opened++;
          } catch {
            // file gone
          }
        } else {
          chatSkipped++;
        }
      }
      if (chatSkipped > 0) {
        vscode.window.showInformationMessage(
          `Opened ${opened} file${opened === 1 ? '' : 's'}. ${chatSkipped} chat bookmark${chatSkipped === 1 ? '' : 's'} listed — open the chat panel manually and use its history.`,
        );
      }
    }),

    vscode.commands.registerCommand('editorGroups.closeGroup', async (item: GroupItem) => {
      const groups = provider.getGroups();
      const uris = new Set(
        (groups[item.name] || []).filter((e) => e.kind === 'file').map((e) => (e as { uri: string }).uri),
      );
      const tabsToClose: vscode.Tab[] = [];
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const uri = extractUri(tab.input);
          if (uri && uris.has(uri.toString())) {
            tabsToClose.push(tab);
          }
        }
      }
      if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose);
      }
    }),
  );
}

export function deactivate() {}
