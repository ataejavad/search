// سرور اپ «ایجنت‌های زندگی»: نگه‌داری ایجنت‌ها، گروه‌ها و تسک‌ها، ثبت کامل تاریخچه،
// و اجرای تسک‌ها با Claude Agent SDK.
import express from 'express';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.LIFE_DATA || join(ROOT, 'data');
const CONFIG_FILE = join(DATA, 'agents.json');
const ME_FILE = join(DATA, 'me.md');
const HISTORY = join(DATA, 'history');
const TASK_LOGS = join(HISTORY, 'tasks');
const JOURNAL = join(HISTORY, 'journal.jsonl');
const WORKSPACE = process.env.LIFE_WORKSPACE || join(ROOT, 'workspace');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4567);

// ابزارهای فقط‌خواندنی که در حالت «با تأیید من» هم بدون پرسش اجرا می‌شوند.
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
// ابزارهای داخلی که در تنظیمات قابل انتخاب‌اند (هم‌خوان با فهرست در public/app.js).
const BUILTIN_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite'];
const LIFE_TOOLS = ['list_agents', 'list_open_tasks', 'add_task', 'about_me', 'remember_about_me'].map((n) => `mcp__life__${n}`);
const DEFAULT_MODEL = 'claude-opus-5-5';

// ---------- ذخیره‌سازی ----------
mkdirSync(TASK_LOGS, { recursive: true });
mkdirSync(join(WORKSPACE, 'shared'), { recursive: true });
if (!existsSync(CONFIG_FILE)) copyFileSync(join(ROOT, 'seed', 'agents.json'), CONFIG_FILE);
if (!existsSync(ME_FILE)) writeFileSync(ME_FILE, '# شناخت من\n\nایجنت‌ها هر چیزی را که درباره‌ی ترجیحات، عادت‌ها، ارزش‌ها و تصمیم‌های من می‌فهمند، این‌جا ثبت می‌کنند.\n\n');
const notesFile = join(WORKSPACE, 'shared', 'notes.md');
if (!existsSync(notesFile)) writeFileSync(notesFile, '# یادداشت‌های مشترک ایجنت‌ها\n\n');

// دفتر رویدادها: هر کاری که شما یا ایجنت‌ها انجام می‌دهید، بدون حذف، به ترتیب زمان.
function journal(type, data = {}) {
  appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n');
}
function appendTaskLog(taskId, line) {
  appendFileSync(join(TASK_LOGS, `${taskId}.jsonl`), JSON.stringify(line) + '\n');
}
function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let state = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
state.agents ??= [];
for (const u of state.agents) {
  u.kind ??= 'agent';
  u.archived ??= false;
  u.mcpServers ??= {};
  if (u.kind === 'group') u.members ??= [];
  for (const t of u.tasks) {
    if (t.status === 'running') t.status = 'stopped';
    t.delegates = [];
    t.archived ??= false;
    t.createdBy ??= 'me';
    // نسخه‌ی قبلی گزارش‌ها را داخل agents.json نگه می‌داشت؛ به فایل تاریخچه منتقل می‌شوند.
    if (t.log) {
      for (const e of t.log) appendTaskLog(t.id, { t: e.t, kind: e.kind, from: e.from, text: e.text });
      delete t.log;
    }
  }
}

let saveTimer = null;
const saveNow = () => writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2) + '\n');
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}
saveNow();

const running = new Map(); // taskId -> AbortController
const approvals = new Map(); // approvalId -> { info, resolve }
const clients = new Set();

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

// ---------- ساختار ایجنت‌ها و گروه‌ها ----------
const findUnit = (id) => state.agents.find((a) => a.id === id);
const activeAgent = (id) => {
  const a = findUnit(id);
  return a && a.kind === 'agent' && !a.archived ? a : null;
};
const childrenOf = (id) => state.agents.filter((a) => a.kind === 'agent' && !a.archived && a.parent === id);
const descendantsOf = (id) => childrenOf(id).flatMap((c) => [c, ...descendantsOf(c.id)]);
// تیم یک ایجنت، زیرمجموعه‌های اوست؛ تیم یک گروه، اعضای آن و زیرمجموعه‌هایشان.
function teamOf(unit) {
  if (unit.kind !== 'group') return descendantsOf(unit.id);
  const all = unit.members.map(activeAgent).filter(Boolean).flatMap((m) => [m, ...descendantsOf(m.id)]);
  return [...new Map(all.map((a) => [a.id, a])).values()];
}

function sharedContext(unit) {
  const team = teamOf(unit);
  const teamText = team.length
    ? `\nاعضای تیم تو (با ابزار Agent کار را به آن‌ها بسپار):\n${team.map((d) => `- ${d.id}: ${d.name} — ${d.description}`).join('\n')}`
    : '';
  return `\n\n---\nتاریخ امروز: ${new Date().toISOString().slice(0, 10)}
پوشه‌ی کاری مشترک همه‌ی ایجنت‌ها همین پوشه‌ی جاری است. یادداشت‌های کاری مشترک در shared/notes.md است.
ابزارهای life در اختیار توست:
- about_me: قبل از هر کار، شناختی را که از من ثبت شده بخوان و مطابق آن عمل کن.
- remember_about_me: هر چیز تازه‌ای درباره‌ی ترجیحات، عادت‌ها، ارزش‌ها و تصمیم‌های من فهمیدی، کوتاه ثبت کن.
- add_task / list_open_tasks / list_agents: کارهایی را که باید بعداً انجام شوند، به‌جای فراموش‌شدن، به‌صورت تسک برای ایجنت مناسب ثبت کن.
من به نظم ذهنی اهمیت زیادی می‌دهم: جواب‌ها مرتب، کوتاه و قابل اقدام باشند و کار باز را رها نکن.
همیشه به فارسی جواب بده.${teamText}`;
}

function newTask(unit, { title, prompt = '', createdBy = 'me' }) {
  const task = {
    id: randomUUID(),
    title,
    prompt,
    status: 'todo',
    result: null,
    error: null,
    sessionId: null,
    costUsd: 0,
    createdBy,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    delegates: [],
  };
  unit.tasks.push(task);
  save();
  journal('task.create', { unit: unit.id, task: task.id, title, prompt, createdBy });
  broadcast({ type: 'agents' });
  return task;
}

function addLog(unit, task, entry) {
  const item = { t: Date.now(), ...entry };
  appendTaskLog(task.id, item);
  broadcast({ type: 'log', agentId: unit.id, taskId: task.id, entry: item });
}

function setTask(unit, task, patch) {
  Object.assign(task, patch, { updatedAt: Date.now() });
  save();
  broadcast({ type: 'task', agentId: unit.id, task });
}

function brief(value, max = 160) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ---------- ابزارهای داخلی اپ برای ایجنت‌ها ----------
const text = (t) => ({ content: [{ type: 'text', text: t }] });

function lifeServer(runner) {
  return createSdkMcpServer({
    name: 'life',
    tools: [
      tool('list_agents', 'فهرست ایجنت‌ها و گروه‌های فعال با شناسه و توضیح.', {}, async () =>
        text(
          state.agents
            .filter((a) => !a.archived)
            .map((a) => `${a.id} (${a.kind === 'group' ? 'گروه' : 'ایجنت'}): ${a.name} — ${a.description}`)
            .join('\n'),
        ),
      ),
      tool('list_open_tasks', 'همه‌ی تسک‌های باز (در انتظار یا در حال اجرا) در کل سیستم.', {}, async () => {
        const rows = state.agents.flatMap((a) =>
          a.tasks
            .filter((t) => !t.archived && ['todo', 'running', 'stopped'].includes(t.status))
            .map((t) => `- [${a.name}] ${t.title}`),
        );
        return text(rows.join('\n') || 'تسک بازی وجود ندارد.');
      }),
      tool(
        'add_task',
        'یک تسک تازه برای یک ایجنت یا گروه ثبت می‌کند. تسک اجرا نمی‌شود تا من آن را اجرا کنم.',
        { agent_id: z.string(), title: z.string(), details: z.string().optional() },
        async ({ agent_id, title, details }) => {
          const unit = findUnit(agent_id);
          if (!unit || unit.archived) return { ...text(`شناسه‌ی «${agent_id}» پیدا نشد. از list_agents استفاده کن.`), isError: true };
          newTask(unit, { title, prompt: details || '', createdBy: runner.id });
          return text(`تسک «${title}» برای ${unit.name} ثبت شد.`);
        },
      ),
      tool('about_me', 'شناختی که تا امروز از من ثبت شده (ترجیحات، عادت‌ها، ارزش‌ها، تصمیم‌ها).', {}, async () =>
        text(readFileSync(ME_FILE, 'utf8')),
      ),
      tool(
        'remember_about_me',
        'یک نکته‌ی تازه درباره‌ی من را در «شناخت من» ثبت می‌کند. فقط چیزهایی که واقعاً از گفته‌ها یا تصمیم‌های من فهمیدی.',
        { note: z.string(), topic: z.string().optional() },
        async ({ note, topic }) => {
          const line = `- ${new Date().toISOString().slice(0, 10)}${topic ? ` [${topic}]` : ''}: ${note} _(ثبت: ${runner.name})_\n`;
          appendFileSync(ME_FILE, line);
          journal('me.note', { unit: runner.id, note, topic });
          broadcast({ type: 'me' });
          return text('ثبت شد.');
        },
      ),
    ],
  });
}

// ---------- اجرای تسک ----------
// اجازه‌ی ابزار را از کاربر می‌پرسد و تا جواب‌دادن او منتظر می‌ماند.
function askApproval(unit, task, toolName, input, signal, viaSubagent) {
  return new Promise((resolve) => {
    const id = randomUUID();
    const info = { id, agentId: unit.id, agentName: unit.name, taskId: task.id, taskTitle: task.title, toolName, input, viaSubagent };
    const done = (result) => {
      if (!approvals.has(id)) return;
      approvals.delete(id);
      journal('approval', { unit: unit.id, task: task.id, tool: toolName, input, allow: result.behavior === 'allow', viaSubagent });
      broadcast({ type: 'approval-done', id });
      resolve(result);
    };
    approvals.set(id, { info, resolve: done });
    signal?.addEventListener('abort', () => done({ behavior: 'deny', message: 'تسک متوقف شد.' }));
    broadcast({ type: 'approval', approval: info });
    addLog(unit, task, { kind: 'wait', text: `منتظر تأیید شما برای ${toolName}` });
  });
}

// فهرست `tools` فقط ابزارهای داخلی را نگه می‌دارد؛ پس برای ایجنتی که MCP دارد
// به‌جای آن ابزارهای داخلیِ انتخاب‌نشده را ممنوع می‌کنیم تا ابزارهای MCP خودش در دسترس بماند.
function subagentToolAccess(d) {
  const servers = Object.keys(d.mcpServers || {});
  if (!servers.length) return { tools: [...d.tools, ...LIFE_TOOLS] };
  return { mcpServers: [...servers, 'life'], disallowedTools: BUILTIN_TOOLS.filter((t) => !d.tools.includes(t)) };
}

function buildOptions(unit, task, abortController) {
  const team = teamOf(unit);
  const tools = [...new Set([...unit.tools, ...(team.length ? ['Agent'] : [])])];

  const options = {
    cwd: WORKSPACE,
    model: unit.model || DEFAULT_MODEL,
    systemPrompt: unit.prompt + sharedContext(unit),
    tools,
    abortController,
    settingSources: [],
    mcpServers: Object.assign({}, ...[unit, ...team].map((a) => a.mcpServers || {}), { life: lifeServer(unit) }),
    agents: Object.fromEntries(
      team.map((d) => [
        d.id,
        {
          description: `${d.name}: ${d.description}`,
          prompt: d.prompt + sharedContext(d),
          model: d.model || DEFAULT_MODEL,
          ...subagentToolAccess(d),
        },
      ]),
    ),
  };

  if (unit.permission === 'full') {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
  } else {
    options.permissionMode = unit.permission === 'auto' ? 'acceptEdits' : 'default';
    options.allowedTools = [...READ_ONLY_TOOLS, ...LIFE_TOOLS];
    options.canUseTool = (toolName, input, { signal, agentID }) => askApproval(unit, task, toolName, input, signal, Boolean(agentID));
  }
  return options;
}

async function runTask(unit, task, followUp) {
  const abortController = new AbortController();
  running.set(task.id, abortController);
  setTask(unit, task, { status: 'running', error: null, delegates: [] });
  const delegations = new Map(); // tool_use_id -> subagent id
  const prompt = followUp || task.prompt || task.title;
  journal(followUp ? 'task.followup' : 'task.run', { unit: unit.id, task: task.id, prompt });
  addLog(unit, task, { kind: 'user', text: prompt });

  try {
    const options = buildOptions(unit, task, abortController);
    if (followUp && task.sessionId) options.resume = task.sessionId;

    for await (const msg of query({ prompt, options })) {
      // پیام‌های کامل SDK هم ذخیره می‌شوند تا تاریخچه چیزی کم نداشته باشد.
      if (['assistant', 'user', 'result'].includes(msg.type)) appendTaskLog(task.id, { raw: msg });

      if (msg.type === 'system' && msg.subtype === 'init') {
        setTask(unit, task, { sessionId: msg.session_id });
      } else if (msg.type === 'assistant') {
        const from = msg.parent_tool_use_id ? 'sub' : 'main';
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            addLog(unit, task, { kind: 'text', from, text: block.text });
          } else if (block.type === 'tool_use') {
            const label = block.name === 'Agent' ? `واگذاری به «${block.input?.subagent_type ?? '?'}»` : block.name;
            addLog(unit, task, { kind: 'tool', from, text: `${label}: ${brief(block.input)}` });
            if (block.name === 'Agent' && findUnit(block.input?.subagent_type)) {
              delegations.set(block.id, block.input.subagent_type);
              setTask(unit, task, { delegates: [...new Set(delegations.values())] });
            }
          }
        }
      } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        // پایان کار یک عضو تیم: نتیجه‌ی ابزار Agent برگشته است.
        const finished = msg.message.content.filter((b) => b.type === 'tool_result' && delegations.delete(b.tool_use_id));
        if (finished.length) setTask(unit, task, { delegates: [...new Set(delegations.values())] });
      } else if (msg.type === 'result') {
        const ok = msg.subtype === 'success' && !msg.is_error;
        setTask(unit, task, {
          status: ok ? 'done' : 'error',
          result: msg.subtype === 'success' ? msg.result : null,
          error: ok ? null : msg.subtype,
          costUsd: (task.costUsd || 0) + (msg.total_cost_usd || 0),
        });
        journal('task.result', { unit: unit.id, task: task.id, ok, result: task.result, costUsd: msg.total_cost_usd });
      }
    }
  } catch (err) {
    const stopped = abortController.signal.aborted;
    addLog(unit, task, { kind: 'error', text: stopped ? 'متوقف شد.' : String(err?.message || err) });
    setTask(unit, task, { status: stopped ? 'stopped' : 'error', error: stopped ? null : String(err?.message || err) });
    journal(stopped ? 'task.stop' : 'task.error', { unit: unit.id, task: task.id, error: task.error });
  } finally {
    running.delete(task.id);
    setTask(unit, task, { delegates: [], ...(task.status === 'running' ? { status: 'done' } : {}) });
  }
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(ROOT, 'public')));
app.use('/vendor', express.static(join(ROOT, 'node_modules', 'd3', 'dist')));

app.get('/api/state', (_req, res) => {
  res.json({ agents: state.agents, approvals: [...approvals.values()].map((a) => a.info) });
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': connected\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

// ثبت سریع: هر فکری که در ذهن دارید، به ستاد سپرده می‌شود تا مرتبش کند.
app.post('/api/capture', (req, res) => {
  const note = String(req.body.text || '').trim();
  if (!note) return res.status(400).json({ error: 'متن خالی است' });
  journal('capture', { text: note });
  const hq = activeAgent('hq') || state.agents.find((a) => a.kind === 'agent' && !a.archived && !a.parent);
  if (!hq) return res.status(400).json({ error: 'هیچ ایجنت ریشه‌ای فعال نیست' });
  const task = newTask(hq, {
    title: note.length > 70 ? note.slice(0, 70) + '…' : note,
    createdBy: 'capture',
    prompt: `ثبت سریع ذهن من:
«${note}»

این را برایم مرتب کن:
1. بفهم چه نوع چیزی است: کار، ایده، نگرانی، یادداشت یا اطلاعاتی درباره‌ی من.
2. اگر کاری لازم است، با add_task برای ایجنت مناسب یک تسک روشن و قابل اقدام ثبت کن (اگر چند کار است، جدا ثبت کن).
3. اگر چیزی درباره‌ی ترجیحات یا زندگی من می‌گوید، با remember_about_me ثبت کن.
4. در یک تا سه خط بگو چه کردی. خودت کار اصلی را انجام نده؛ فقط مرتب کن. این یادداشت بعد از تمام‌شدن کار تو خودبه‌خود بسته می‌شود.`,
  });
  runTask(hq, task);
  res.json(task);
});

const EDITABLE = ['name', 'icon', 'description', 'prompt', 'model', 'permission', 'tools', 'mcpServers', 'parent', 'members'];
const pick = (body) => Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]]));

function validParent(agentId, parent) {
  if (parent === null) return true;
  if (!activeAgent(parent)) return false;
  return parent !== agentId && !descendantsOf(agentId).some((d) => d.id === parent);
}

app.post('/api/agents', (req, res) => {
  const kind = req.body.kind === 'group' ? 'group' : 'agent';
  const parent = kind === 'agent' ? (req.body.parent ?? null) : null;
  if (parent !== null && !activeAgent(parent)) return res.status(400).json({ error: 'والد پیدا نشد' });
  const base =
    kind === 'group'
      ? {
          name: 'گروه جدید',
          icon: '👥',
          description: '',
          prompt: 'تو هماهنگ‌کننده‌ی این گروه هستی. کار را بین اعضا تقسیم کن و نتیجه را یکپارچه و کوتاه گزارش کن.',
          tools: ['Read', 'Glob', 'Grep'],
          members: [],
        }
      : {
          name: 'ایجنت جدید',
          icon: '🤖',
          description: '',
          prompt: 'تو یک ایجنت کمکی هستی.',
          tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
        };
  const unit = {
    id: (req.body.id || `${kind}-${randomUUID().slice(0, 6)}`).replace(/[^a-zA-Z0-9_-]/g, ''),
    kind,
    parent,
    model: DEFAULT_MODEL,
    permission: 'ask',
    mcpServers: {},
    archived: false,
    ...base,
    ...pick(req.body),
    tasks: [],
  };
  if (findUnit(unit.id)) return res.status(400).json({ error: 'این شناسه قبلاً استفاده شده' });
  state.agents.push(unit);
  save();
  journal(`${kind}.create`, { unit: unit.id, config: { ...unit, tasks: undefined } });
  broadcast({ type: 'agents' });
  res.json(unit);
});

app.put('/api/agents/:id', (req, res) => {
  const unit = findUnit(req.params.id);
  if (!unit) return res.sendStatus(404);
  const patch = pick(req.body);
  if (unit.kind === 'group') delete patch.parent;
  else delete patch.members;
  if ('parent' in patch && !validParent(unit.id, patch.parent)) return res.status(400).json({ error: 'والد نامعتبر است' });
  if ('members' in patch) patch.members = [...new Set(patch.members)].filter((m) => findUnit(m)?.kind === 'agent');
  const changed = Object.keys(patch).filter((k) => JSON.stringify(unit[k]) !== JSON.stringify(patch[k]));
  const before = Object.fromEntries(changed.map((k) => [k, unit[k]]));
  Object.assign(unit, patch);
  save();
  if (changed.length) {
    journal(`${unit.kind}.update`, { unit: unit.id, before, after: Object.fromEntries(changed.map((k) => [k, patch[k]])) });
  }
  broadcast({ type: 'agents' });
  res.json(unit);
});

// حذف واقعی نداریم: بایگانی، ایجنت را از درخت و همکاری‌ها بیرون می‌برد ولی تاریخچه‌اش می‌ماند.
app.post('/api/agents/:id/archive', (req, res) => {
  const unit = findUnit(req.params.id);
  if (!unit) return res.sendStatus(404);
  const archived = req.body.archived !== false;
  if (archived && unit.tasks.some((t) => running.has(t.id))) return res.status(400).json({ error: 'اول تسک‌های در حال اجرا را متوقف کنید' });
  const moved = [];
  if (archived && unit.kind === 'agent') {
    for (const c of childrenOf(unit.id)) {
      c.parent = unit.parent;
      moved.push(c.id);
    }
  }
  unit.archived = archived;
  if (!archived && unit.parent && !activeAgent(unit.parent)) unit.parent = null;
  save();
  journal(`${unit.kind}.${archived ? 'archive' : 'restore'}`, { unit: unit.id, movedChildren: moved });
  broadcast({ type: 'agents' });
  res.json(unit);
});

app.post('/api/agents/:id/tasks', (req, res) => {
  const unit = findUnit(req.params.id);
  if (!unit) return res.sendStatus(404);
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'عنوان تسک لازم است' });
  const task = newTask(unit, { title, prompt: String(req.body.prompt || '').trim() });
  if (req.body.run) runTask(unit, task);
  res.json(task);
});

function findTask(req, res) {
  const unit = findUnit(req.params.id);
  const task = unit?.tasks.find((t) => t.id === req.params.taskId);
  if (!task) res.sendStatus(404);
  return task && { unit, task };
}

app.get('/api/agents/:id/tasks/:taskId/log', (req, res) => {
  const found = findTask(req, res);
  if (!found) return;
  res.json(readJsonl(join(TASK_LOGS, `${found.task.id}.jsonl`)).filter((l) => !l.raw));
});

app.post('/api/agents/:id/tasks/:taskId/run', (req, res) => {
  const found = findTask(req, res);
  if (!found) return;
  if (running.has(found.task.id)) return res.status(400).json({ error: 'این تسک در حال اجراست' });
  runTask(found.unit, found.task, String(req.body.followUp || '').trim() || null);
  res.sendStatus(202);
});

app.post('/api/agents/:id/tasks/:taskId/stop', (req, res) => {
  const found = findTask(req, res);
  if (!found) return;
  running.get(found.task.id)?.abort();
  res.sendStatus(202);
});

app.post('/api/agents/:id/tasks/:taskId/archive', (req, res) => {
  const found = findTask(req, res);
  if (!found) return;
  running.get(found.task.id)?.abort();
  found.task.archived = req.body.archived !== false;
  save();
  journal(found.task.archived ? 'task.archive' : 'task.restore', { unit: found.unit.id, task: found.task.id });
  broadcast({ type: 'agents' });
  res.sendStatus(204);
});

app.post('/api/approvals/:id', (req, res) => {
  const pending = approvals.get(req.params.id);
  if (!pending) return res.sendStatus(404);
  pending.resolve(
    req.body.allow
      ? { behavior: 'allow', updatedInput: pending.info.input }
      : { behavior: 'deny', message: req.body.message || 'کاربر اجازه نداد.' },
  );
  res.sendStatus(204);
});

app.get('/api/me', (_req, res) => {
  const events = readJsonl(JOURNAL);
  const count = (type) => events.filter((e) => e.type === type).length;
  res.json({
    text: readFileSync(ME_FILE, 'utf8'),
    stats: {
      events: events.length,
      captures: count('capture'),
      tasks: count('task.create'),
      approvals: count('approval'),
      notes: count('me.note'),
      since: events[0]?.at ?? null,
    },
    dataDir: DATA,
  });
});

app.put('/api/me', (req, res) => {
  const before = readFileSync(ME_FILE, 'utf8');
  const after = String(req.body.text ?? '');
  writeFileSync(ME_FILE, after);
  journal('me.edit', { before, after });
  broadcast({ type: 'me' });
  res.sendStatus(204);
});

// خروجی کامل همه‌ی داده‌ها در یک فایل، برای پشتیبان یا ساختن «نسخه‌ی دیجیتال من» در آینده.
app.get('/api/export', (_req, res) => {
  const taskLogs = Object.fromEntries(
    readdirSync(TASK_LOGS)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => [f.replace('.jsonl', ''), readJsonl(join(TASK_LOGS, f))]),
  );
  const date = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="life-agents-${date}.json"`);
  res.json({ exportedAt: new Date().toISOString(), config: state, me: readFileSync(ME_FILE, 'utf8'), journal: readJsonl(JOURNAL), taskLogs });
});

app.listen(PORT, HOST, () => {
  console.log(`ایجنت‌های زندگی: http://${HOST}:${PORT}`);
  console.log(`داده‌ها: ${DATA}`);
  console.log(`پوشه‌ی کاری ایجنت‌ها: ${WORKSPACE}`);
});
