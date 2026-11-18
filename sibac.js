#!/usr/bin/env node
// sibac: SIBA's coding agent for the terminal. Zero dependencies, Node 18+.
//   sibac                 interactive session in the current folder
//   sibac "fix the test"  one task, then exit      (--yes approves every action without asking)
// Talks the OpenAI chat-completions protocol to the endpoint in ~/.sibac/config.json
// ({ baseUrl, apiKey, model }; SIBAC_BASE_URL / SIBAC_API_KEY / SIBAC_MODEL override it).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const readline = require('readline/promises');

const VERSION = '0.1.0';
const CONF = path.join(os.homedir(), '.sibac', 'config.json');
const GITBASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const SHELL = process.platform !== 'win32' ? ['/bin/bash', '-c'] : fs.existsSync(GITBASH) ? [GITBASH, '-c'] : ['powershell.exe', '-NoProfile', '-Command'];
const SKIP = new Set(['node_modules', '.git', '.next', '.venv', 'venv', '__pycache__', 'dist', 'build']);

const paint = (n) => (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = paint(2), bold = paint(1), red = paint(31), green = paint(32);
const BLUE = [46, 134, 224], CYAN = [63, 211, 222];   // SIBA brand blue and cyan (src/app/globals.css)
const rgb = ([r, g, b]) => paint(`38;2;${r};${g};${b}`);
const accent = rgb(BLUE), cyan = rgb(CYAN);
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');   // text without colour codes, to measure its width

const abs = (p) => path.resolve(process.cwd(), String(p || '.'));
// Where a path really lands: links are resolved on the deepest part that exists (a new file has no real path yet).
const real = (p) => {
  const rest = [];
  for (let cur = p; ; ) {
    let there = true;
    try { fs.lstatSync(cur); } catch (e) { if (e.code !== 'ENOENT') throw e; there = false; }
    if (there) return path.join(fs.realpathSync(cur), ...rest);   // a dangling link throws here, and inside() then says "outside"
    const up = path.dirname(cur);
    if (up === cur) return p;
    rest.unshift(path.basename(cur));
    cur = up;
  }
};
// A link inside the folder that points out of it counts as outside; anything unresolvable does too.
const inside = (p) => {
  try {
    const r = path.relative(fs.realpathSync(process.cwd()), real(p));
    return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r);
  } catch { return false; }
};
const clip = (s, n = 20000) => (s.length > n ? s.slice(0, n) + `\n... [${s.length - n} more characters cut]` : s);
const str = (description) => ({ type: 'string', description });

// ask: the user confirms each call. once: "always" is not offered (every command is confirmed).
const TOOLS = {
  read_file: {
    desc: 'Read a text file. For a long file pass offset (first line, 1-based) and limit (number of lines, default 400).',
    params: { path: str('file path'), offset: { type: 'integer' }, limit: { type: 'integer' } }, req: ['path'],
    run({ path: p, offset = 1, limit = 400 }) {
      const lines = fs.readFileSync(abs(p), 'utf8').replace(/\r\n/g, '\n').split('\n');
      const more = lines.length > offset - 1 + limit ? `\n... [file has ${lines.length} lines; read on with offset ${offset + limit}]` : '';
      return lines.slice(offset - 1, offset - 1 + limit).join('\n') + more;
    },
  },
  list_dir: {
    desc: 'List the files and folders in a directory (folders end with /).',
    params: { path: str('directory, default the working directory') }, req: [],
    run({ path: p }) {
      return fs.readdirSync(abs(p), { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : '')).join('\n') || '(empty)';
    },
  },
  grep: {
    desc: 'Search file contents under a directory with a regular expression (case-insensitive). Returns file:line: text, at most 100 matches.',
    params: { pattern: str('regular expression'), path: str('directory to search, default the working directory') }, req: ['pattern'],
    run({ pattern, path: p }) {
      const re = new RegExp(pattern, 'i'), hits = [];
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (hits.length >= 100) return;
          const f = path.join(d, e.name);
          if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(f); continue; }
          if (!e.isFile() || fs.statSync(f).size > 1e6) continue;
          const text = fs.readFileSync(f, 'utf8');
          if (text.includes('\0')) continue;   // binary
          text.split('\n').forEach((l, i) => { if (hits.length < 100 && re.test(l)) hits.push(`${path.relative(process.cwd(), f)}:${i + 1}: ${l.trim().slice(0, 200)}`); });
        }
      })(abs(p));
      return hits.join('\n') || 'no matches';
    },
  },
  write_file: {
    ask: true, desc: 'Create a file, or replace its whole content. Use edit_file to change part of an existing file.',
    params: { path: str('file path'), content: str('the full file content') }, req: ['path', 'content'],
    run({ path: p, content }) {
      fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
      fs.writeFileSync(abs(p), content);
      return `wrote ${p} (${content.split('\n').length} lines)`;
    },
  },
  edit_file: {
    ask: true, desc: 'Replace one exact piece of text in a file. old_string must appear exactly once: include enough surrounding lines to make it unique.',
    params: { path: str('file path'), old_string: str('exact text to replace'), new_string: str('replacement text') }, req: ['path', 'old_string', 'new_string'],
    run({ path: p, old_string, new_string }) {
      const raw = fs.readFileSync(abs(p), 'utf8'), crlf = raw.includes('\r\n');
      const text = raw.replace(/\r\n/g, '\n'), old = old_string.replace(/\r\n/g, '\n');
      const n = old ? text.split(old).length - 1 : 0;
      if (n !== 1) throw new Error(n ? `old_string appears ${n} times in ${p}; add surrounding lines to make it unique` : `old_string not found in ${p}; read the file again and copy the text exactly`);
      const out = text.replace(old, () => new_string.replace(/\r\n/g, '\n'));
      fs.writeFileSync(abs(p), crlf ? out.replace(/\n/g, '\r\n') : out);   // keep the file's own line endings
      return `edited ${p}`;
    },
  },
  run_command: {
    ask: true, once: true, desc: `Run a shell command in the working directory (${path.basename(SHELL[0])}, 2 minute limit, no interactive input). Returns the exit code and output.`,
    params: { command: str('the command line') }, req: ['command'],
    run({ command }) {
      const r = cp.spawnSync(SHELL[0], [...SHELL.slice(1), command], { cwd: process.cwd(), encoding: 'utf8', timeout: 120000, maxBuffer: 16e6, stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.error) return `failed: ${r.error.message}`;
      return `exit ${r.status}\n${r.stdout || ''}${r.stderr || ''}`.trim();
    },
  },
};
const SCHEMA = Object.entries(TOOLS).map(([name, t]) => ({ type: 'function', function: { name, description: t.desc, parameters: { type: 'object', properties: t.params, required: t.req } } }));

const always = new Set();
// Model text is untrusted: control codes (escape sequences, carriage returns) could repaint the screen and hide what is being approved.
// Covers control and invisible format characters too (bidi overrides, zero-width, line separators); only \n and \t pass.
const vis = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' || c === '\t' ? c : `\\u{${c.codePointAt(0).toString(16)}}`));
// The one-line summary of a call: always the field that tool acts on, with line breaks made visible.
const label = (name, a) => vis(name === 'run_command' ? a.command : name === 'grep' ? `${a.pattern} in ${a.path || '.'}` : a.path || '.').replace(/\n/g, '\\n');
const VERB = { read_file: 'Read', list_dir: 'List', grep: 'Search', write_file: 'Write', edit_file: 'Edit', run_command: 'Run' };
// Light markdown for replies: headings, bullets, bold, inline code, code blocks. Runs after vis(), so the only colour codes are ours.
const md = (s) => {
  let code = false;
  return vis(s).split('\n').map((l) => {
    if (/^\s*```/.test(l)) { code = !code; return dim(l); }
    if (code) return cyan(l);
    return l.replace(/^#{1,6}\s+(.*)$/, (_, t) => bold(t)).replace(/^(\s*)[-*]\s+/, '$1• ')
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t)).replace(/`([^`]+)`/g, (_, t) => cyan(t));
  }).join('\n');
};
// What a command returned, in one dim line: "exit 0 · first line of output (+N lines)".
const tail = (out) => {
  const l = vis(out).split('\n').filter((x) => x.trim());
  return dim('  └ ' + l.slice(0, 2).join(' · ').slice(0, 110) + (l.length > 2 ? `  (+${l.length - 2} lines)` : ''));
};
// One status line while waiting for the model (terminal only); returns the function that removes it.
const status = { text: '' };
function spin(text) {
  if (!process.stdout.isTTY) return () => {};
  status.text = text;
  const frames = ['●∙∙', '∙●∙', '∙∙●', '∙●∙'], t0 = Date.now();
  let i = 0;
  const draw = () => process.stdout.write(`\r\x1b[2K  ${accent(frames[i++ % 4])} ${dim(`${status.text} ${Math.round((Date.now() - t0) / 1000)}s`)}`);
  draw();
  const timer = setInterval(draw, 180);
  return () => { clearInterval(timer); process.stdout.write('\r\x1b[2K'); };
}
function show(name, a) {
  const few = (s, mark, color) => {
    const lines = vis(s).split('\n');
    return lines.slice(0, 8).map((l) => color(`    ${mark} ${l}`)).join('\n') + (lines.length > 8 ? dim(`\n      ... ${lines.length - 8} more lines not shown`) : '');
  };
  console.log(accent('● ') + bold(VERB[name]) + ' ' + dim(label(name, a)));
  if (name === 'edit_file') console.log(few(a.old_string, '-', red) + '\n' + few(a.new_string, '+', green));
  if (name === 'write_file') console.log(few(a.content, '+', green));
}
async function allowed(name, args, ctx) {
  const t = TOOLS[name];
  if (!t.ask) return true;
  const outside = args.path !== undefined && !inside(abs(args.path));   // a change outside the working folder is always confirmed
  if ((ctx.yes || always.has(name)) && !outside) return true;
  if (!ctx.rl) return false;
  const keys = outside || t.once ? 'y yes · n no' : 'y yes · a always this session · n no';
  const a = (await ctx.rl.question('  ' + (outside ? red('Outside this folder. ') : '') + bold('Allow? ') + dim(keys) + accent(' › '))).trim().toLowerCase();
  if (a.startsWith('a') && !t.once) { always.add(name); return true; }
  return a.startsWith('y');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chat(conf, messages) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(conf.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${conf.apiKey}`, 'content-type': 'application/json' },
      // shortcut: the reply is not streamed, it prints when complete; add stream:true and delta assembly if answers feel slow
      body: JSON.stringify({ model: conf.model, messages, tools: SCHEMA, tool_choice: 'auto', temperature: 0.2 }),
    });
    if (r.status === 429 && tries < 4) {
      const s = Math.min(60, Math.ceil(Number(r.headers.get('retry-after')) || 5 * (tries + 1)));
      if (process.stdout.isTTY) status.text = `rate limited, waiting ${s}s ·`; else console.log(dim(`  rate limited, waiting ${s}s`));
      await sleep(s * 1000);
      status.text = 'thinking';
      continue;
    }
    const body = await r.text();
    if (r.status === 400 && body.includes('tool_use_failed') && tries < 2) continue;   // the model wrote a malformed tool call: ask again
    if (!r.ok) throw new Error(`model API ${r.status}: ${body.slice(0, 300)}`);
    return JSON.parse(body).choices[0].message;
  }
}

// shortcut: no summarising; old tool output is cut once the history passes ~300k characters, /clear starts fresh
function trim(messages) {
  let size = messages.reduce((n, m) => n + (m.content || '').length, 0);
  for (const m of messages) {
    if (size < 300000) break;
    if (m.role === 'tool' && m.content.length > 300) { size -= m.content.length - 300; m.content = m.content.slice(0, 300) + ' ...[old output cut]'; }
  }
}

async function turn(conf, messages, ctx) {
  for (let step = 0; step < 40; step++) {
    trim(messages);
    const stop = spin('thinking');
    let m;
    try { m = await chat(conf, messages); } finally { stop(); }
    // gpt-oss repeats the same tool call forever unless its own reasoning is sent back with the call
    messages.push({ role: 'assistant', content: m.content || '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}), ...(m.reasoning ? { reasoning: m.reasoning } : {}) });
    if (m.content?.trim()) console.log('\n' + md(m.content.trim()) + '\n');
    if (!m.tool_calls?.length) return;
    for (const call of m.tool_calls) {
      let out;
      try {
        const name = call.function.name.split('.').pop();   // the model sometimes writes repo_browser.list_dir
        if (!Object.hasOwn(TOOLS, name)) throw new Error(`unknown tool ${name}`);
        // only the arguments the tool declares: an extra one must not reach the prompt or the tool
        const args = Object.fromEntries(Object.entries(JSON.parse(call.function.arguments || '{}')).filter(([k]) => Object.hasOwn(TOOLS[name].params, k)));
        show(name, args);
        if (await allowed(name, args, ctx)) {
          out = String(TOOLS[name].run(args));
          if (name === 'run_command') console.log(tail(out));
        } else {
          out = 'The user declined this action. Do not retry it; ask what they want instead.';
          console.log(dim('  └ declined'));
        }
      } catch (e) {
        out = 'Error: ' + e.message;
        console.log(red('  ' + out));
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: clip(out) });
    }
  }
  console.log(dim('Stopped after 40 steps. Say "continue" to go on.'));
}

const system = (conf) => `You are SIBA Code (sibac), a coding agent made by SIBA that works in the user's terminal.
Working directory: ${process.cwd()}
System: ${process.platform}; run_command uses ${path.basename(SHELL[0])}. Date: ${new Date().toISOString().slice(0, 10)}.
You run on the model "${conf.model}"; say so plainly if asked which model you are.

How to work:
- Look before you change: list the folder, grep, and read the files involved. Never guess at a file's content.
- Make the smallest change that fully does the job. Use edit_file for existing files and write_file only for new ones.
- After a change, check it when you can (run the test, the script or the build) and report the real result, including failures.
- Stay inside the working directory unless the user asks otherwise.
- Never ask for permission in your reply: call the tool. The program itself asks the user before each write and command. If a call comes back declined, do not retry it; ask what they want instead.
- Be brief: a short plan if the task is big, then act. End with one or two sentences on what changed and what was not checked.
- Reply in the language the user writes in (Azerbaijani, English, Russian or any other).`;

const LOGO = ['███████ ██ ██████   █████ ', '██      ██ ██   ██ ██   ██', '███████ ██ ██████  ███████', '     ██ ██ ██   ██ ██   ██', '███████ ██ ██████  ██   ██'];
// The welcome screen: logo and session facts in a frame; a two-line header when the window is narrow.
function banner(conf) {
  const cols = process.stdout.columns || 80, cwd = process.cwd();
  if (cols < 72) return console.log('\n  ' + accent('█ ') + bold('SIBA Code') + dim('  v' + VERSION) + '\n  ' + dim(cwd) + '\n  ' + dim(conf.model + ' · /help') + '\n');
  const R = Math.min(cols - 36, Math.max(34, 8 + cwd.length, 8 + conf.model.length));   // width of the right-hand column
  const fit = (s) => (s.length > R - 8 ? '…' + s.slice(s.length - (R - 9)) : s);
  const info = [bold('SIBA Code') + dim('  v' + VERSION), dim('Coding agent for your terminal'), '', dim('folder  ') + fit(cwd), dim('model   ') + fit(conf.model)];
  const shade = (i) => rgb(BLUE.map((c, k) => Math.round(c + ((CYAN[k] - c) * i) / 4)));   // blue on the top row to cyan on the bottom
  const row = (l, r) => accent('│') + '  ' + l + '    ' + r + ' '.repeat(R - plain(r).length) + '  ' + accent('│');
  console.log('\n' + accent('╭' + '─'.repeat(R + 34) + '╮'));
  console.log(row(' '.repeat(26), ''));
  LOGO.forEach((l, i) => console.log(row(shade(i)(l), info[i])));
  console.log(row(' '.repeat(26), ''));
  console.log(accent('╰' + '─'.repeat(R + 34) + '╯'));
  console.log(dim('  Describe a task in any language, for example ') + '"explain this project"' + dim(' or ') + '"fix the failing test"');
  console.log(dim('  /help commands · /clear new conversation · /exit leave\n'));
}

function loadConf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch {}
  return {
    baseUrl: process.env.SIBAC_BASE_URL || c.baseUrl || 'https://api.groq.com/openai/v1',
    apiKey: process.env.SIBAC_API_KEY || c.apiKey,
    model: process.env.SIBAC_MODEL || c.model || 'openai/gpt-oss-120b',
  };
}

// First run: the user brings their own OpenAI-compatible endpoint and key; Enter keeps the default in brackets.
async function firstRun(rl, conf, file = CONF) {
  console.log(`\n${bold('SIBA Code')} needs a model endpoint that speaks the OpenAI chat API, and your own key for it.\n${dim(`Default: Groq (keys at https://console.groq.com/keys). Saved in ${file}, on this computer only.`)}\n`);
  conf.baseUrl = (await rl.question(`Endpoint [${conf.baseUrl}]: `)).trim() || conf.baseUrl;
  conf.model = (await rl.question(`Model [${conf.model}]: `)).trim() || conf.model;
  conf.apiKey = (await rl.question('API key: ')).trim();
  // shortcut: erases one screen line, so a key long enough to wrap stays partly visible; mute the input if that matters
  if (process.stdout.isTTY) process.stdout.write('\x1b[1A\x1b[2K');
  if (!conf.apiKey) throw new Error('no key entered');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) return console.log(VERSION);
  if (argv.includes('--help')) return console.log('sibac            interactive coding agent in this folder\nsibac "task"     do one task and exit\n  --yes          approve every file change and command without asking\nIn a session: /clear forgets the conversation, /exit leaves.\nEndpoint, model and key: ' + CONF + ' (or SIBAC_BASE_URL, SIBAC_MODEL, SIBAC_API_KEY).');
  const prompt = argv.filter((a) => !a.startsWith('--')).join(' ');
  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  if (rl) rl.on('close', () => process.exit(0));   // Ctrl+C / Ctrl+D
  const conf = loadConf();
  if (!conf.apiKey) {
    if (!rl) throw new Error(`no API key: set SIBAC_API_KEY or put it in ${CONF}`);
    await firstRun(rl, conf);
  }
  const messages = [{ role: 'system', content: system(conf) }];
  const ctx = { rl, yes: argv.includes('--yes') };
  if (prompt) {
    messages.push({ role: 'user', content: prompt });
    await turn(conf, messages, ctx);
    return rl?.close();
  }
  if (!rl) throw new Error('no task given: run sibac "task", or start sibac in a terminal');
  banner(conf);
  for (;;) {
    const line = (await rl.question(accent('› '))).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/clear') { messages.length = 1; always.clear(); console.log(dim('  conversation cleared\n')); continue; }
    if (line === '/help') { console.log(dim('  /help   this list\n  /clear  forget the conversation and start again\n  /exit   leave (Ctrl+C also works)\n  File changes and commands always ask for your OK first.\n')); continue; }
    messages.push({ role: 'user', content: line });
    const t0 = Date.now();
    try { await turn(conf, messages, ctx); console.log(dim(`  finished in ${Math.round((Date.now() - t0) / 1000)}s\n`)); } catch (e) { console.error(red('  ' + e.message + '\n')); }
  }
  console.log(dim('  Goodbye.'));
  rl.close();
}

if (require.main === module) main().catch((e) => { console.error(red(e.message)); process.exit(1); });
module.exports = { TOOLS, inside, abs, allowed, vis, label, md, plain, banner, firstRun, VERSION };
