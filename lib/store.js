'use strict';
// What sibac keeps on disk: the endpoint choice, saved conversations, skills and the project guide.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib');
const { HOSTED, GROQ } = require('./api.js');
const { dim, bold, accent } = require('./ui.js');

const home = () => process.env.SIBAC_HOME || path.join(os.homedir(), '.sibac');
const confFile = () => path.join(home(), 'config.json');
const validUrl = (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };

function readConf(file = confFile()) {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return c && typeof c === 'object' ? c : null; } catch { return null; }
}
// The settings for this run: environment over file over defaults. problem: 'new' (nothing saved yet) or 'broken' (the saved endpoint is not a URL).
function resolveConf(c, env = process.env) {
  const baseUrl = String(env.SIBAC_BASE_URL || c?.baseUrl || HOSTED), hosted = baseUrl === HOSTED;
  let model = String(env.SIBAC_MODEL || c?.model || (hosted ? 'siba-code' : 'openai/gpt-oss-120b'));
  if (!hosted && /^siba-(code|oak)$/.test(model)) model = 'openai/gpt-oss-120b';   // the hosted names mean nothing to another endpoint
  const conf = { baseUrl, model, apiKey: env.SIBAC_API_KEY || c?.apiKey || undefined };
  return { conf, problem: !validUrl(baseUrl) ? 'broken' : !c && !env.SIBAC_BASE_URL ? 'new' : null };
}
function writeConf(c, file = confFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ baseUrl: c.baseUrl, model: c.model, ...(c.apiKey ? { apiKey: c.apiKey } : {}) }, null, 2), { mode: 0o600 });
}
// Changes single fields of the saved file, so values that came from the environment are never written into it.
function patchConf(patch, file = confFile()) {
  writeConf({ ...resolveConf(readConf(file), {}).conf, ...patch }, file);
}

// The endpoint menu (first run, /login, and the repair of a broken config). Every answer is checked and asked again when it cannot work.
async function setup(rl, conf, file = confFile()) {
  const q = async (text, o) => String((await rl.question(text, o)) ?? '').trim();
  console.log(`\n${bold('Which model line should SIBA Code use?')}\n\n  ${accent('1)')} SIBA hosted   ${dim('free, no key needed; runs open models (default)')}\n  ${accent('2)')} Groq          ${dim('with my own key')}\n  ${accent('3)')} Another OpenAI-compatible endpoint\n`);
  let n;
  while (!['1', '2', '3'].includes(n = (await q('Choose 1, 2 or 3 [1]: ')) || '1')) console.log(dim('  Type 1, 2 or 3, or press Enter for 1.'));
  const was = validUrl(conf.baseUrl) && conf.baseUrl !== HOSTED ? conf : {};   // old answers are offered as defaults only when they could work
  const next = { baseUrl: HOSTED, model: 'siba-code' };
  if (n !== '1') {
    next.baseUrl = n === '2' ? GROQ : '';
    while (!next.baseUrl) {
      const u = (await q(`Endpoint address${was.baseUrl ? ` [${was.baseUrl}]` : ''}: `)) || was.baseUrl || '';
      if (validUrl(u)) next.baseUrl = u; else console.log(dim('  That is not a web address. It starts with http:// or https://, for example http://localhost:11434/v1'));
    }
    const same = was.baseUrl === next.baseUrl ? was : {};   // a saved model and key are only offered again for the endpoint they belong to
    const model = same.model || (n === '2' ? 'openai/gpt-oss-120b' : '');
    while (!(next.model = (await q(`Model${model ? ` [${model}]` : ''}: `)) || model)) console.log(dim('  Type the model name the endpoint expects.'));
    for (;;) {
      const k = await q(`${n === '2' ? 'Groq API key (from https://console.groq.com/keys)' : 'API key'}${same.apiKey ? ' [Enter keeps the saved one]' : n === '3' ? ' [Enter for none]' : ''}: `, { hide: true });
      next.apiKey = k || same.apiKey;
      if (next.apiKey ? /^\S{8,}$/.test(next.apiKey) : n === '3') break;
      console.log(dim(k ? '  That does not look like a key (too short, or it has spaces).' : '  Groq needs a key. Ctrl+C leaves; choice 1 works without one.'));
    }
  }
  Object.assign(conf, { apiKey: undefined }, next);
  writeConf(conf, file);
  console.log(dim(`\n  Saved in ${file}, on this computer only. /login changes it.`));
}

// Conversations, one JSON file each, in a folder per working directory. Only the messages are stored: never the endpoint settings or the key.
const sessionDir = (cwd) => path.join(home(), 'sessions', crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12));
const newSession = (cwd = process.cwd()) => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), cwd, started: new Date().toISOString() });
function saveSession(s, messages) {
  const turns = messages.slice(1);   // the system prompt is rebuilt when the conversation is reopened
  if (!turns.length) return;
  fs.mkdirSync(sessionDir(s.cwd), { recursive: true });
  const title = String(turns.find((m) => m.role === 'user')?.content || '').replace(/\s+/g, ' ').slice(0, 70);
  fs.writeFileSync(path.join(sessionDir(s.cwd), s.id + '.json'), JSON.stringify({ id: s.id, cwd: s.cwd, started: s.started, updated: new Date().toISOString(), title, messages: turns }), { mode: 0o600 });
}
function listSessions(cwd = process.cwd()) {
  let names = [];
  try { names = fs.readdirSync(sessionDir(cwd)); } catch {}
  return names.filter((n) => n.endsWith('.json')).map((n) => { try { return JSON.parse(fs.readFileSync(path.join(sessionDir(cwd), n), 'utf8')); } catch { return null; } })
    .filter((s) => s && Array.isArray(s.messages)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

// A skill file: optional YAML frontmatter (name, description; a folded "description: >" block is read too), then the instructions.
function parseSkill(raw, fallback) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text), meta = {};
  const lines = fm ? fm[1].split(/\r?\n/) : [];
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (!v || /^[>|][+-]?$/.test(v)) for (v = ''; i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]); ) v += (v ? ' ' : '') + lines[++i].trim();
    meta[kv[1]] = v.replace(/^(['"])(.*)\1$/, '$2');
  }
  const body = (fm ? fm[2] : text).trim();
  // the name becomes a /command, so anything else than letters, digits, dot, dash and underscore falls back to the file or folder name
  const name = (/^\w[\w.-]*$/.test(meta.name || '') ? meta.name : String(fallback).replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '') || 'skill').toLowerCase();
  return { name, description: (meta.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').trim().slice(0, 300), body };
}
// Skills by priority: the project's own, the user's, an existing .claude/skills folder (read only), then the ones shipped with sibac.
function findSkills(cwd = process.cwd()) {
  const found = new Map();
  for (const [dir, source] of [[path.join(cwd, '.sibac', 'skills'), 'project'], [path.join(home(), 'skills'), 'user'], [path.join(cwd, '.claude', 'skills'), '.claude'], [path.join(__dirname, '..', 'skills'), 'built-in']]) {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch {}
    for (const n of names) {
      const file = n.endsWith('.md') ? path.join(dir, n) : path.join(dir, n, 'SKILL.md');
      try {
        const s = parseSkill(fs.readFileSync(file, 'utf8'), n.replace(/\.md$/, ''));
        if (s.body && !found.has(s.name)) found.set(s.name, { ...s, file, source });
      } catch {}   // not a skill: a folder without SKILL.md, or an unreadable file
    }
  }
  return [...found.values()];
}

// The project guide that goes into the system prompt: SIBAC.md, or AGENTS.md when there is none. Capped, because it is sent with every request.
function memory(cwd = process.cwd(), cap = 8000) {
  for (const name of ['SIBAC.md', 'AGENTS.md']) {
    try {
      const t = fs.readFileSync(path.join(cwd, name), 'utf8').trim();
      if (t) return { name, text: t.length > cap ? t.slice(0, cap) + '\n[the file is longer; the rest was cut]' : t };
    } catch {}
  }
  return null;
}

// A downloaded skill archive is untrusted: a few kilobytes can unpack to gigabytes, and a path in it can point anywhere.
// Skill folders are small text, so the limits are strict (bytes; files and total count what is taken from the archive).
const LIMITS = { download: 16e6, unpacked: 32e6, files: 300, file: 1e6, total: 8e6 };
// The regular files of a tar archive that lie under one folder, without the top folder GitHub adds (named after the commit).
// Throws on a path that leaves the archive's folder (anywhere in the archive) and past any limit. Links are listed in .links, not returned.
// shortcut: reads the classic name and prefix fields only; a path longer than 255 bytes (pax header) comes out cut, which a skill folder does not have
function untar(buf, under = '', lim = LIMITS) {
  const out = Object.assign([], { links: [] });
  let total = 0;
  for (let o = 0; o < buf.length && buf[o]; ) {
    const field = (at, n) => buf.subarray(o + at, o + at + n).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 12).trim() || '0', 8), type = field(156, 1), prefix = field(345, 155);
    const name = ((prefix ? prefix + '/' : '') + field(0, 100)).replace(/^[^/]+\//, '');
    if (!(size >= 0) || o + 512 + size > buf.length) throw new Error('the archive is damaged or cut short; nothing was written');
    if (type === '0' || type === '' || type === '1' || type === '2') {   // a file, or a hard or symbolic link
      if (/^\/|\\|:/.test(name) || name.split('/').includes('..')) throw new Error(`the archive holds a path that leaves its folder (${name}); nothing was written`);
      if (type === '1' || type === '2') out.links.push(name);   // never written; unpackSkills refuses a skill folder that has one
      else if (name.startsWith(under)) {
        if (size > lim.file) throw new Error(`${name} is larger than ${lim.file / 1e6} MB, too large for a skill; nothing was written`);
        if (out.length >= lim.files) throw new Error(`more than ${lim.files} files there; give the path of one skill folder. Nothing was written`);
        if ((total += size) > lim.total) throw new Error(`more than ${lim.total / 1e6} MB of files there; give the path of one skill folder. Nothing was written`);
        out.push({ name, data: buf.subarray(o + 512, o + 512 + size) });
      }
    }
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
// The skill folders (those with a SKILL.md) under one path of a gzipped repository archive.
function unpackSkills(packed, under = '', fallback = 'skill') {
  let tar;
  try { tar = zlib.gunzipSync(packed, { maxOutputLength: LIMITS.unpacked }); }
  catch (e) { throw new Error(e.code === 'ERR_BUFFER_TOO_LARGE' ? `that archive unpacks to more than ${LIMITS.unpacked / 1e6} MB, far more than skill folders need; nothing was written` : 'that download is not a readable archive; nothing was written'); }
  const files = untar(tar, under);
  return files.filter((f) => /(^|\/)SKILL\.md$/.test(f.name)).map((f) => {
    const dir = f.name.slice(0, -'SKILL.md'.length), link = files.links.find((l) => l.startsWith(dir));
    if (link) throw new Error(`the skill folder holds a link (${link}), which could point anywhere; nothing was written`);
    return { ...parseSkill(f.data.toString('utf8'), path.posix.basename(dir) || fallback), files: files.filter((x) => x.name.startsWith(dir)).map((x) => ({ rel: x.name.slice(dir.length), data: x.data })) };
  });
}
// sibac skills add owner/repo[/path]: downloads the repository archive from GitHub and returns its skill folders, ready for installSkill.
async function githubSkills(src) {
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(.+?))?\/?$/.exec(src.replace(/^https:\/\/github\.com\//, ''));
  if (!m) throw new Error('give the source as owner/repo or owner/repo/path, for example anthropics/skills/skills/pdf');
  const r = await fetch(`${process.env.SIBAC_GITHUB || 'https://github.com'}/${m[1]}/${m[2]}/tarball/HEAD`, { signal: AbortSignal.timeout(60000), headers: { 'user-agent': 'sibac' } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${m[1]}/${m[2]}. Check the name; private repositories are not supported.`);
  const chunks = [];
  let size = 0;
  for await (const c of r.body) {
    if ((size += c.length) > LIMITS.download) throw new Error(`that repository is larger than ${LIMITS.download / 1e6} MB packed; skills are installed from small repositories only. Nothing was written`);
    chunks.push(c);
  }
  return unpackSkills(Buffer.concat(chunks), m[3] ? m[3] + '/' : '', m[2]);
}
function installSkill(s) {
  if (!/^\w[\w.-]*$/.test(s.name)) throw new Error(`"${s.name}" cannot be a skill name; nothing was written`);
  const dest = path.join(home(), 'skills', s.name);
  for (const f of s.files) {
    const to = path.join(dest, ...f.rel.split('/'));
    if (path.relative(dest, to).startsWith('..') || path.isAbsolute(path.relative(dest, to))) throw new Error(`${f.rel} would be written outside the skill folder; stopped`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, f.data);
  }
  return dest;
}

module.exports = { home, confFile, validUrl, readConf, resolveConf, writeConf, patchConf, setup, newSession, saveSession, listSessions, parseSkill, findSkills, memory, untar, unpackSkills, githubSkills, installSkill };
