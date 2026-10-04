// سرور اپ «ایجنت‌های زندگی»: نگه‌داری ایجنت‌ها و تسک‌ها، و اجرای تسک‌ها با Claude Agent SDK.
import express from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(ROOT, 'data', 'agents.json');
const WORKSPACE = process.env.LIFE_WORKSPACE || join(ROOT, 'workspace');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4567);

// ابزارهای فقط‌خواندنی که در حالت «با تأیید من» هم بدون پرسش اجرا می‌شوند.
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const MAX_LOG = 400;
// ابزارهای داخلی که در تنظیمات قابل انتخاب‌اند (هم‌خوان با فهرست در public/app.js).
const BUILTIN_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite'];

mkdirSync(join(WORKSPACE, 'shared'), { recursive: true });
const notesFile = join(WORKSPACE, 'shared', 'notes.md');
if (!existsSync(notesFile)) writeFileSync(notesFile, '# حافظه‌ی مشترک ایجنت‌ها\n\n');

let state = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
// تسک‌هایی که هنگام خاموش‌شدن سرور در حال اجرا بودند، دیگر اجرا نمی‌شوند.
for (const a of state.agents) for (const t of a.tasks) {
  if (t.status === 'running') t.status = 'stopped';
  t.delegates = [];
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFileSync(DATA_FILE, JSON.stringify(state, null, 2) + '\n'), 200);
}

const running = new Map(); // taskId -> AbortController
const approvals = new Map(); // approvalId -> { info, resolve }
const clients = new Set();

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

const findAgent = (id) => state.agents.find((a) => a.id === id);
const childrenOf = (id) => state.agents.filter((a) => a.parent === id);
function descendantsOf(id) {
  return childrenOf(id).flatMap((c) => [c, ...descendantsOf(c.id)]);
}

function sharedContext(agent) {
  const team = descendantsOf(agent.id);
  const teamText = team.length
    ? `\nزیرمجموعه‌های تو (با ابزار Agent به آن‌ها کار بسپار):\n${team.map((d) => `- ${d.id}: ${d.name} — ${d.description}`).join('\n')}`
    : '';
  return `\n\n---\nتاریخ امروز: ${new Date().toISOString().slice(0, 10)}
پوشه‌ی کاری مشترک همه‌ی ایجنت‌ها همین پوشه‌ی جاری است.
حافظه‌ی مشترک: فایل shared/notes.md. قبل از کار آن را بخوان و نکته‌های مهمی را که بقیه‌ی ایجنت‌ها باید بدانند، به آن اضافه کن.
همیشه به فارسی جواب بده.${teamText}`;
}

function addLog(agent, task, entry) {
  const item = { t: Date.now(), ...entry };
  task.log.push(item);
  if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
  broadcast({ type: 'log', agentId: agent.id, taskId: task.id, entry: item });
}

function setTask(agent, task, patch) {
  Object.assign(task, patch, { updatedAt: Date.now() });
  save();
  broadcast({ type: 'task', agentId: agent.id, task: { ...task, log: undefined } });
}

function brief(value, max = 160) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// اجازه‌ی ابزار را از کاربر می‌پرسد و تا جواب‌دادن او منتظر می‌ماند.
function askApproval(agent, task, toolName, input, signal, viaSubagent) {
  return new Promise((resolve) => {
    const id = randomUUID();
    const info = { id, agentId: agent.id, agentName: agent.name, taskId: task.id, taskTitle: task.title, toolName, input, viaSubagent };
    const done = (result) => {
      approvals.delete(id);
      broadcast({ type: 'approval-done', id });
      resolve(result);
    };
    approvals.set(id, { info, resolve: done });
    signal?.addEventListener('abort', () => done({ behavior: 'deny', message: 'تسک متوقف شد.' }));
    broadcast({ type: 'approval', approval: info });
    addLog(agent, task, { kind: 'wait', text: `منتظر تأیید شما برای ${toolName}` });
  });
}

// فهرست `tools` فقط ابزارهای داخلی را نگه می‌دارد؛ پس برای ایجنتی که MCP دارد
// به‌جای آن ابزارهای داخلیِ انتخاب‌نشده را ممنوع می‌کنیم تا ابزارهای MCP خودش در دسترس بماند.
function subagentToolAccess(d) {
  const servers = Object.keys(d.mcpServers || {});
  if (!servers.length) return { tools: d.tools };
  return { mcpServers: servers, disallowedTools: BUILTIN_TOOLS.filter((t) => !d.tools.includes(t)) };
}

function buildOptions(agent, task, abortController) {
  const team = descendantsOf(agent.id);
  const tools = [...new Set([...agent.tools, ...(team.length ? ['Agent'] : [])])];

  const options = {
    cwd: WORKSPACE,
    model: agent.model,
    systemPrompt: agent.prompt + sharedContext(agent),
    tools,
    abortController,
    settingSources: [],
    mcpServers: Object.assign({}, ...[agent, ...team].map((a) => a.mcpServers || {})),
    agents: Object.fromEntries(
      team.map((d) => [
        d.id,
        {
          description: `${d.name}: ${d.description}`,
          prompt: d.prompt + sharedContext(d),
          model: d.model,
          ...subagentToolAccess(d),
        },
      ]),
    ),
  };

  if (agent.permission === 'full') {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
  } else {
    options.permissionMode = agent.permission === 'auto' ? 'acceptEdits' : 'default';
    options.allowedTools = READ_ONLY_TOOLS;
    options.canUseTool = (toolName, input, { signal, agentID }) => askApproval(agent, task, toolName, input, signal, Boolean(agentID));
  }
  return options;
}

async function runTask(agent, task, followUp) {
  const abortController = new AbortController();
  running.set(task.id, abortController);
  setTask(agent, task, { status: 'running', error: null, delegates: [] });
  const delegations = new Map(); // tool_use_id -> subagent id
  const prompt = followUp || task.prompt || task.title;
  addLog(agent, task, { kind: 'user', text: prompt });

  try {
    const options = buildOptions(agent, task, abortController);
    if (followUp && task.sessionId) options.resume = task.sessionId;

    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        setTask(agent, task, { sessionId: msg.session_id });
      } else if (msg.type === 'assistant') {
        const from = msg.parent_tool_use_id ? 'sub' : 'main';
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            addLog(agent, task, { kind: 'text', from, text: block.text });
          } else if (block.type === 'tool_use') {
            const label = block.name === 'Agent' ? `واگذاری به «${block.input?.subagent_type ?? '?'}»` : block.name;
            addLog(agent, task, { kind: 'tool', from, text: `${label}: ${brief(block.input)}` });
            if (block.name === 'Agent' && findAgent(block.input?.subagent_type)) {
              delegations.set(block.id, block.input.subagent_type);
              setTask(agent, task, { delegates: [...new Set(delegations.values())] });
            }
          }
        }
      } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        // پایان کار یک ایجنت زیرمجموعه: نتیجه‌ی ابزار Agent برگشته است.
        const finished = msg.message.content.filter((b) => b.type === 'tool_result' && delegations.delete(b.tool_use_id));
        if (finished.length) setTask(agent, task, { delegates: [...new Set(delegations.values())] });
      } else if (msg.type === 'result') {
        const ok = msg.subtype === 'success' && !msg.is_error;
        setTask(agent, task, {
          status: ok ? 'done' : 'error',
          result: msg.subtype === 'success' ? msg.result : null,
          error: ok ? null : msg.subtype,
          costUsd: (task.costUsd || 0) + (msg.total_cost_usd || 0),
        });
      }
    }
  } catch (err) {
    const stopped = abortController.signal.aborted;
    addLog(agent, task, { kind: 'error', text: stopped ? 'متوقف شد.' : String(err?.message || err) });
    setTask(agent, task, { status: stopped ? 'stopped' : 'error', error: stopped ? null : String(err?.message || err) });
  } finally {
    running.delete(task.id);
    setTask(agent, task, { delegates: [], ...(task.status === 'running' ? { status: 'done' } : {}) });
  }
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
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

const EDITABLE = ['name', 'icon', 'description', 'prompt', 'model', 'permission', 'tools', 'mcpServers', 'parent'];
const pick = (body) => Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]]));

function validParent(agentId, parent) {
  if (parent === null) return true;
  if (!findAgent(parent)) return false;
  return parent !== agentId && !descendantsOf(agentId).some((d) => d.id === parent);
}

app.post('/api/agents', (req, res) => {
  const parent = req.body.parent ?? null;
  if (parent !== null && !findAgent(parent)) return res.status(400).json({ error: 'والد پیدا نشد' });
  const agent = {
    id: (req.body.id || 'agent-' + randomUUID().slice(0, 6)).replace(/[^a-zA-Z0-9_-]/g, ''),
    parent,
    name: 'ایجنت جدید',
    icon: '🤖',
    description: '',
    prompt: 'تو یک ایجنت کمکی هستی.',
    model: 'claude-opus-5-5',
    permission: 'ask',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    mcpServers: {},
    ...pick(req.body),
    tasks: [],
  };
  if (findAgent(agent.id)) return res.status(400).json({ error: 'این شناسه قبلاً استفاده شده' });
  state.agents.push(agent);
  save();
  broadcast({ type: 'agents' });
  res.json(agent);
});

app.put('/api/agents/:id', (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.sendStatus(404);
  const patch = pick(req.body);
  if ('parent' in patch && !validParent(agent.id, patch.parent)) return res.status(400).json({ error: 'والد نامعتبر است' });
  Object.assign(agent, patch);
  save();
  broadcast({ type: 'agents' });
  res.json(agent);
});

app.delete('/api/agents/:id', (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.sendStatus(404);
  if (agent.tasks.some((t) => running.has(t.id))) return res.status(400).json({ error: 'اول تسک‌های در حال اجرا را متوقف کنید' });
  for (const c of childrenOf(agent.id)) c.parent = agent.parent;
  state.agents = state.agents.filter((a) => a !== agent);
  save();
  broadcast({ type: 'agents' });
  res.sendStatus(204);
});

app.post('/api/agents/:id/tasks', (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.sendStatus(404);
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'عنوان تسک لازم است' });
  const task = {
    id: randomUUID(),
    title,
    prompt: String(req.body.prompt || '').trim(),
    status: 'todo',
    result: null,
    error: null,
    sessionId: null,
    costUsd: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    log: [],
  };
  agent.tasks.push(task);
  save();
  broadcast({ type: 'agents' });
  if (req.body.run) runTask(agent, task);
  res.json(task);
});

function findTask(req, res) {
  const agent = findAgent(req.params.id);
  const task = agent?.tasks.find((t) => t.id === req.params.taskId);
  if (!task) res.sendStatus(404);
  return task && { agent, task };
}

app.post('/api/agents/:id/tasks/:taskId/run', (req, res) => {
  const found = findTask(req, res);
  if (!found) return;
  if (running.has(found.task.id)) return res.status(400).json({ error: 'این تسک در حال اجراست' });
  runTask(found.agent, found.task, String(req.body.followUp || '').trim() || null);
  res.sendStatus(202);
});

app.post('/api/agents/:id/tasks/:taskId/stop', (req, res) => {
  const found = findTask(req, res);
  if (!found) return;
  running.get(found.task.id)?.abort();
  res.sendStatus(202);
});

app.delete('/api/agents/:id/tasks/:taskId', (req, res) => {
  const found = findTask(req, res);
  if (!found) return;
  running.get(found.task.id)?.abort();
  found.agent.tasks = found.agent.tasks.filter((t) => t !== found.task);
  save();
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

app.listen(PORT, HOST, () => {
  console.log(`ایجنت‌های زندگی: http://${HOST}:${PORT}`);
  console.log(`پوشه‌ی کاری ایجنت‌ها: ${WORKSPACE}`);
});
