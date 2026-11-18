// node cli/e2e.js : drives the real program, as a child process, against a local stand-in for the model endpoint.
// One-shot runs use plain pipes (nobody can answer). The interactive runs set SIBAC_TTY=1, which makes sibac treat the
// pipes as a terminal, so the menu, the approval prompt, Tab, the / menu and Ctrl+C are exercised byte by byte, but no real terminal draws them.
// Not shipped in the package.
'use strict';
const assert = require('assert'), http = require('http'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const CLI = path.join(__dirname, 'sibac.js'), ESC = String.fromCodePoint(0x1b), CTRL_C = String.fromCodePoint(3), DEL = String.fromCodePoint(0x7f);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `sibac-e2e-${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');   // output without escape sequences

// ---- the stand-in endpoint: /<scenario>/v1/chat/completions, scripted per scenario ----
const log = [];   // every chat request: { scenario, headers, body }
const of = (name) => log.filter((r) => r.scenario === name);
const after = (body) => body.messages.length - 1 - body.messages.findLastIndex((m) => m.role === 'user');   // messages since the user spoke: 0, then 2 per finished tool call
const asked = (body) => String(body.messages.filter((m) => m.role === 'user').at(-1)?.content || '');
const call = (name, args) => ({ calls: [{ name, args }] });
const twelve = Array.from({ length: 12 }, (_, i) => 'line' + (i + 1)).join('\n');
const scenarios = {
  // the hosted line: an agent that follows the user's words
  hosted(body) {
    const q = asked(body), n = after(body);
    if (body.messages[0].content.startsWith('You summarise')) return { text: 'SUMMARY: the user made a file.' };
    if (body.model === 'siba-oak') return { text: 'Salam! Men SIBA Oak.', model: 'siba-oak-3.0' };
    if (/create and run/.test(q)) return n === 0 ? { ...call('repo_browser.write_file', { path: 'hello.js', content: 'console.log("hi from sibac")\n', bogus: 'dropped' }), reasoning: 'I should write the file first.' }
      : n === 2 ? call('run_command', { command: 'node hello.js' }) : { text: '# Done\nThe script printed **hi from sibac**.' };
    if (/make a file/.test(q)) return n === 0 ? call('write_file', { path: 'made.txt', content: twelve }) : { text: 'Made it.' };
    if (/edit it/.test(q)) return n === 0 ? call('edit_file', { path: 'made.txt', old_string: 'line1\n', new_string: 'LINE1\n' }) : n === 2 ? call('edit_file', { path: 'made.txt', old_string: 'line2\n', new_string: 'LINE2\n' }) : { text: 'Edited twice.' };
    if (/run it/.test(q)) return n === 0 ? call('run_command', { command: 'echo should-not-run > ran.txt' }) : { text: 'You declined, so nothing ran.' };
    if (/write outside/.test(q)) return n === 0 ? call('write_file', { path: '../outside-e2e.txt', content: 'x' }) : { text: 'It was declined.' };
    if (/fetch local/.test(q)) return n === 0 ? call('fetch_url', { url: `http://127.0.0.1:${port}/hosted/v1/models` }) : { text: 'That address is refused.' };
    if (/use a skill/.test(q)) return n === 0 ? call('use_skill', { name: 'deploy' }) : { text: 'Followed the skill.' };
    if (/plan/.test(q)) return n === 0 ? call('todo', { items: [{ text: 'read the code', status: 'done' }, { text: 'change it', status: 'doing' }, { text: 'test it' }] }) : { text: 'Planned.' };
    if (/SIBAC\.md/.test(q)) return n === 0 ? call('write_file', { path: 'SIBAC.md', content: '# Project\nRun: node hello.js\n' }) : { text: 'Wrote the guide.' };
    if (/slow/.test(q)) return { text: 'Slow part 1\nSlow part 2\nSlow part 3\nSlow part 4\n', delay: 700 };
    if (/too big/.test(q)) return n < 4 ? call('list_dir', {}) : { status: 413, body: 'Request too large' };
    if (/^Summary of our conversation/.test(q) && body.messages.length === 2) return { text: 'Went on from the summary.' };
    return { text: `You said: ${q.slice(0, 60)}`, usage: { total_tokens: 1234 } };
  },
  busy: (body, n) => (n === 0 ? { status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'The free line is busy.' } } } : { text: 'Through after waiting.' }),
  capped: () => ({ status: 429, headers: { 'retry-after': '7200' }, body: { error: { message: 'You reached 200 requests today.' } } }),
  jammed: () => ({ status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'All models are busy.' } } }),
  broken: () => ({ status: 500, body: { error: { message: 'upstream exploded' } } }),
  origin: () => ({ status: 403, body: { error: 'origin' } }),
  huge: () => ({ status: 413, body: 'Request too large' }),
  badkey: () => ({ status: 401, body: { error: { message: 'Unknown key.' } } }),
  oakdown: () => ({ status: 503, body: { error: { message: 'upstream' } } }),
  nostream: () => ({ text: 'Plain JSON reply.', json: true }),                                   // ignores "stream": true
  rejectstream: (body) => (body.stream ? { status: 400, body: { error: { message: 'stream is not supported' } } } : { text: 'Reply without streaming.' }),
  notchat: () => ({ status: 200, body: { hello: 'world' } }),
};
const counts = {};
let port;
const server = http.createServer(async (req, res) => {
  const [, scenario, ...rest] = req.url.split('/');
  if (scenario === 'gh') {   // GitHub's tarball address, for "sibac skills add"
    const entry = (name, data, type = '0') => { const h = Buffer.alloc(512), d = Buffer.from(data); h.write(name, 0); h.write(d.length.toString(8).padStart(11, '0'), 124); h.write(type, 156); return Buffer.concat([h, d, Buffer.alloc((512 - (d.length % 512)) % 512)]); };
    const skill = [entry('repo-1a2b/skills/greet/SKILL.md', '---\nname: greet\ndescription: Say hello politely\n---\nGreet the user.'), entry('repo-1a2b/skills/greet/notes/tone.md', 'warm'), entry('repo-1a2b/other/SKILL.md', 'not asked for')];
    const repo = { repo: skill, climbs: [...skill, entry('repo-1a2b/skills/greet/../../../evil.md', 'no')], linked: [...skill, entry('repo-1a2b/skills/greet/key', '', '2')] }[rest[1]];
    res.writeHead(200, { 'content-type': 'application/x-gzip' });
    return res.end(zlib.gzipSync(rest[1] === 'bomb' ? Buffer.alloc(40e6) : Buffer.concat([...repo, Buffer.alloc(1024)])));   // bomb: 39 KB that unpack to 40 MB
  }
  if (rest.join('/') === 'v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'siba-code' }, { id: 'siba-oak' }] })); }
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw), n = (counts[scenario] = (counts[scenario] ?? -1) + 1);
  log.push({ scenario, headers: req.headers, body });
  const r = scenarios[scenario](body, n);
  if (r.status) { res.writeHead(r.status, { 'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json', ...r.headers }); return res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)); }
  const model = r.model || 'mock/upstream-model', calls = (r.calls || []).map((c, i) => ({ id: `call_${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  if (!body.stream || r.json) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: r.text || '', ...(r.reasoning ? { reasoning: r.reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) } }], usage: r.usage || { total_tokens: 10 } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (delta, extra) => res.write('data: ' + JSON.stringify({ model, choices: [{ delta }], ...extra }) + '\n\n');
  ev({ role: 'assistant' });
  if (r.reasoning) ev({ reasoning: r.reasoning });
  for (const piece of (r.text || '').match(r.delay ? /[^\n]*\n/g : /[\s\S]{1,5}/g) || []) { ev({ content: piece }); if (r.delay) await sleep(r.delay); }
  calls.forEach((c, i) => { ev({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments.slice(0, 9) } }] }); ev({ tool_calls: [{ index: i, function: { arguments: c.function.arguments.slice(9) } }] }); });
  if (r.usage) res.write('data: ' + JSON.stringify({ model, choices: [], usage: r.usage }) + '\n\n');
  res.end('data: [DONE]\n\n');
});

// ---- running the program ----
const base = (scenario) => `http://127.0.0.1:${port}/${scenario}/v1`;
const env = (home, extra = {}) => {
  const e = { ...process.env, SIBAC_HOME: home, SIBAC_HOSTED: base('hosted'), SIBAC_GITHUB: `http://127.0.0.1:${port}/gh`, NO_COLOR: '1', ...extra };
  for (const k of ['SIBAC_BASE_URL', 'SIBAC_MODEL', 'SIBAC_API_KEY', 'SIBAC_TTY']) if (!(k in extra)) delete e[k];
  for (const k of Object.keys(e)) if (e[k] === null) delete e[k];
  return e;
};
// one run with nobody at the keyboard
const run = (args, o = {}) => new Promise((done) => {
  const c = cp.spawn(process.execPath, [CLI, ...args], { cwd: o.cwd, env: env(o.home, o.env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => { out += '\n[e2e: killed after 40 seconds]'; c.kill(); }, 40000);
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (out += d));
  c.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
});
// a session driven key by key
function session(args, o = {}) {
  const c = cp.spawn(process.execPath, [CLI, ...args], { cwd: o.cwd, env: env(o.home, { SIBAC_TTY: '1', ...o.env }), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', at = 0;
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (out += d));
  const closed = new Promise((done) => c.on('close', done));
  return {
    raw: () => out,
    send: (s) => c.stdin.write(s),
    exit: () => closed,
    // waits until the output after the last match shows the pattern
    async expect(re, ms = 15000) {
      for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(25)) {
        const rest = text(out).slice(at), m = re.exec(rest);
        if (m) { at += m.index + m[0].length; return m; }
      }
      c.kill();
      throw new Error(`waited for ${re} but the output went on with:\n${text(out).slice(at).slice(-1500)}`);
    },
  };
}
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---- one-shot runs: nobody can answer ----
test('no settings: answers through the hosted line without a key; creates and runs a file with --yes', async () => {
  const cwd = tmp('create'), home = tmp('home');
  const r = await run(['--yes', 'create and run a script'], { cwd, home });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'hello.js'), 'utf8'), 'console.log("hi from sibac")\n');
  assert.match(r.out, /● Write hello\.js/);
  assert.match(r.out, /● Run node hello\.js\n\s+└ exit 0 · hi from sibac/);
  assert.match(r.out, /\nDone\nThe script printed hi from sibac\.\n/);               // streamed, markdown rendered
  assert.match(r.out, /s · about [\d,]+ tokens · SIBA hosted · mock\/upstream-model/);   // the status line names the model that really answered; this stream carried no token count
  assert.ok(!r.out.includes('dropped'));
  const reqs = of('hosted').slice(-3);
  assert.deepStrictEqual(reqs.map((q) => [q.headers['x-sibac-version'], q.headers['user-agent'], q.headers.authorization, q.headers.origin, q.body.model, q.body.stream, q.body.tool_choice]), Array(3).fill(['0.2.0', 'sibac/0.2.0', undefined, undefined, 'siba-code', true, 'auto']));
  assert.strictEqual(reqs[1].body.messages[2].tool_calls[0].function.name, 'repo_browser.write_file');
  assert.strictEqual(reqs[1].body.messages[2].reasoning, 'I should write the file first.');   // reasoning goes back with the call
  assert.match(reqs[2].body.messages.at(-1).content, /^exit 0\nhi from sibac/);
  assert.ok(reqs[0].body.tools.length === 10 && reqs[0].body.messages[0].content.includes('not a model trained by SIBA'));
  assert.ok(!fs.existsSync(path.join(home, 'config.json')), 'a one-shot run writes no settings');
});
test('nobody to ask and no --yes: the change is declined', async () => {
  const cwd = tmp('declined');
  const r = await run(['-p', 'make a file'], { cwd, home: tmp('home') });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /● Write made\.txt[\s\S]*└ declined[\s\S]*Made it\./);
  assert.ok(!fs.existsSync(path.join(cwd, 'made.txt')));
  assert.match(of('hosted').at(-1).body.messages.at(-1).content, /The user declined this action/);
});
test('--yes never reaches outside the folder; a local address is never fetched', async () => {
  const cwd = tmp('outside'), target = path.join(path.dirname(cwd), 'outside-e2e.txt');
  fs.rmSync(target, { force: true });
  let r = await run(['--yes', '-p', 'write outside'], { cwd, home: tmp('home') });
  assert.match(r.out, /● Write \.\.\/outside-e2e\.txt[\s\S]*└ declined/);
  assert.ok(!fs.existsSync(target));
  r = await run(['--yes', '-p', 'fetch local'], { cwd, home: tmp('home') });
  assert.match(r.out, /● Fetch http:\/\/127\.0\.0\.1:\d+\/hosted\/v1\/models\n\s+Error: 127\.0\.0\.1 is a private, local or reserved address/);
  r = await run(['-p', 'fetch local'], { cwd, home: tmp('home') });
  assert.match(r.out, /● Fetch [\s\S]*└ declined/);                                   // and without --yes it is not even tried
});
test('skills: /name runs one, the model can load one, the task list shows, @file attaches', async () => {
  const cwd = tmp('skills'), home = tmp('home');
  fs.mkdirSync(path.join(cwd, '.sibac', 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.sibac', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nRun the deploy script.');
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'the secret number is 7');
  let r = await run(['-p', '/explain the parser'], { cwd, home });
  assert.match(of('hosted').at(-1).body.messages[1].content, /^Use the skill "explain"\. The task: the parser\n\nInstructions of the skill "explain"[\s\S]*follow one real path through the code/);
  r = await run(['-p', 'use a skill'], { cwd, home });
  assert.match(r.out, /● Skill deploy[\s\S]*Followed the skill\./);
  assert.match(of('hosted').at(-1).body.messages.at(-1).content, /Run the deploy script\.$/);
  assert.match(of('hosted').at(-1).body.messages[0].content, /- deploy: Ship it\n[\s\S]*- review: /);
  r = await run(['-p', 'plan the work'], { cwd, home });
  assert.match(r.out, /● Tasks 3 tasks\n    ● read the code\n    › change it\n    ○ test it\n/);
  r = await run(['-p', 'what is in @notes.txt ?'], { cwd, home });
  assert.match(r.out, /attached notes\.txt \(1 lines\)/);
  assert.match(of('hosted').at(-1).body.messages[1].content, /^what is in @notes\.txt \?\n\n<file path="notes\.txt">\nthe secret number is 7\n<\/file>$/);
});
test('--continue reopens the conversation of this folder; the key is sent but never saved with it', async () => {
  const cwd = tmp('continue'), home = tmp('home'), key = 'sk_siba_E2E_SECRET_0123456789';
  await run(['-p', 'remember the word plum'], { cwd, home, env: { SIBAC_API_KEY: key } });
  assert.strictEqual(of('hosted').at(-1).headers.authorization, 'Bearer ' + key);
  const r = await run(['--continue', '-p', 'what was the word?'], { cwd, home });
  assert.match(r.out, /Reopened: remember the word plum \(2 messages\)/);
  assert.deepStrictEqual(of('hosted').at(-1).body.messages.slice(1).map((m) => m.role + ':' + m.content), ['user:remember the word plum', 'assistant:You said: remember the word plum', 'user:what was the word?']);
  assert.match(r.out, /1,234 tokens/);                                                // the endpoint's own count
  const saved = fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).filter((f) => f.endsWith('.json'));
  assert.strictEqual(saved.length, 1);
  assert.ok(!fs.readFileSync(path.join(home, 'sessions', saved[0]), 'utf8').includes(key));
  assert.match((await run(['--continue', '-p', 'hello'], { cwd: tmp('empty'), home })).out, /No conversation is saved for this folder yet/);
});
test('rate limits: a short one is waited out, a daily cap is not, and both read as sentences', async () => {
  const o = () => ({ cwd: tmp('limits'), home: tmp('home') });
  let r = await run(['-p', 'hi'], { ...o(), env: { SIBAC_HOSTED: base('busy') } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /The free line is busy\. Trying again in 1s[\s\S]*Through after waiting\./);
  const t0 = Date.now();
  r = await run(['-p', 'hi'], { ...o(), env: { SIBAC_HOSTED: base('capped') } });
  assert.ok(r.code === 1 && Date.now() - t0 < 5000 && of('capped').length === 1, 'no waiting and no second try on a cap that lasts hours');
  assert.match(r.out, /^You reached 200 requests today\. It opens again in about 2 hours\. To go on now, use your own key: \/login\.$/m);
  r = await run(['-p', 'hi'], { ...o(), env: { SIBAC_HOSTED: base('jammed') } });
  assert.ok(r.code === 1 && of('jammed').length === 4);
  assert.match(r.out, /^All models are busy\. Wait a minute and send it again, or use your own key: \/login\.$/m);
});
test('errors read as sentences: 500, 403 with a string body, 413 as text, 401, Oak offline, no connection, not a chat endpoint', async () => {
  const say = async (scenario, extra = {}, args = ['-p', 'hi']) => { const r = await run(args, { cwd: tmp('err'), home: tmp('home'), env: { SIBAC_HOSTED: base(scenario), ...extra } }); assert.strictEqual(r.code, 1, r.out); return r.out.trim(); };
  assert.strictEqual(await say('broken'), 'The model service has a problem (500). It said: upstream exploded. Try again in a moment.');
  assert.strictEqual(await say('origin'), 'The endpoint refused the request (403). It said: origin. If it needs a key, enter it with /login.');
  assert.strictEqual(await say('huge'), 'This request is too large for the free hosted line. It said: Request too large. /compact shrinks the conversation; attach smaller files; or use your own key: /login.');
  assert.strictEqual(await say('badkey', { SIBAC_API_KEY: 'sk_siba_wrong_key' }), 'The key was not accepted (401). It said: Unknown key. /login enters another one, /logout goes on without a key.');
  assert.strictEqual(await say('oakdown', {}, ['--model', 'siba-oak', '-p', 'salam']), 'SIBA Oak is offline right now (it runs on a small server that is not always on). Switch back with /model siba-code.');
  assert.match(await say('x', { SIBAC_HOSTED: 'http://127.0.0.1:9/v1' }), /^Could not reach 127\.0\.0\.1:9 \(.*\)\. Check the internet connection and the endpoint address; "sibac doctor" tests both\.$/);
  assert.match(await say('notchat'), /answered, but not with a chat reply\. Is .* an OpenAI-compatible endpoint\? \/login changes it\.$/);
  assert.strictEqual(await say('x', { SIBAC_BASE_URL: 'groq' }), 'SIBAC_BASE_URL is not a web address (it must start with http:// or https://)');
});
test('an endpoint that does not stream still answers', async () => {
  let r = await run(['-p', 'hi'], { cwd: tmp('ns'), home: tmp('home'), env: { SIBAC_BASE_URL: base('nostream'), SIBAC_MODEL: 'm' } });
  assert.match(r.out, /Plain JSON reply\.\n[\s\S]*tokens · m\n/);
  r = await run(['-p', 'hi'], { cwd: tmp('rs'), home: tmp('home'), env: { SIBAC_BASE_URL: base('rejectstream'), SIBAC_MODEL: 'm' } });
  assert.match(r.out, /Reply without streaming\./);
  assert.deepStrictEqual(of('rejectstream').map((q) => !!q.body.stream), [true, false]);
});
test('a request too large for the line is summarised once and sent again', async () => {
  const r = await run(['-p', 'this gets too big'], { cwd: tmp('big'), home: tmp('home') });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Too large for this line: summarising the conversation and trying again\.[\s\S]*Went on from the summary\./);
  assert.deepStrictEqual(of('hosted').at(-1).body.messages.slice(1), [{ role: 'user', content: 'Summary of our conversation so far (the full text was compacted). Go on from here:\nSUMMARY: the user made a file.' }]);
});
test('a broken saved endpoint ("1") does not fail every message when nobody can answer', async () => {
  const home = tmp('home'), conf = path.join(home, 'config.json'), bad = JSON.stringify({ baseUrl: '1', model: 'openai/gpt-oss-120b', apiKey: 'gsk_old_key_0123456789' });
  fs.writeFileSync(conf, bad);
  const r = await run(['-p', 'hello'], { cwd: tmp('brk'), home });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /The saved endpoint "1" is not a web address[\s\S]*Using SIBA hosted for this run[\s\S]*You said: hello/);
  assert.ok(of('hosted').at(-1).headers.authorization === undefined && of('hosted').at(-1).body.model === 'siba-code', 'the key of the broken settings is not sent to the hosted line');
  assert.strictEqual(fs.readFileSync(conf, 'utf8'), bad);
});
test('the plain commands: --version, --help, update, doctor, an unknown option, no task', async () => {
  const o = { cwd: tmp('cmd'), home: tmp('home') };
  assert.strictEqual((await run(['--version'], o)).out, '0.2.0\n');
  assert.match((await run(['--help'], o)).out, /sibac -p, --print "task"[\s\S]*sibac doctor[\s\S]*open models \(not a SIBA-trained one\)/);
  assert.match((await run(['update'], o)).out, /npm install -g https:\/\/github\.com\/aghasalim\/sibac\/tarball\/main/);
  let r = await run(['doctor'], o);
  assert.ok(r.code === 0 && /ok\s+node[\s\S]*ok\s+config\s+nothing saved yet[\s\S]*ok\s+endpoint\s+127\.0\.0\.1:\d+ answers \(HTTP 200[\s\S]*ok\s+git/.test(r.out), r.out);
  r = await run(['doctor'], { ...o, env: { SIBAC_BASE_URL: 'http://127.0.0.1:9/v1', SIBAC_API_KEY: 'sk_siba_DOCTOR_SECRET' } });
  assert.ok(r.code === 1 && /FAIL endpoint\s+127\.0\.0\.1:9 cannot be reached/.test(r.out) && !r.out.includes('DOCTOR_SECRET'), r.out);
  r = await run(['--frobnicate'], o);
  assert.ok(r.code === 1 && /unknown option --frobnicate/.test(r.out));
  r = await run([], o);
  assert.ok(r.code === 1 && /no task given/.test(r.out));
});
test('skills add: asks before it writes, takes only the folder asked for; a hostile archive writes nothing', async () => {
  const home = tmp('home'), o = { cwd: tmp('add'), home };
  let r = await run(['skills', 'add', 'someone/repo/skills'], o);
  assert.match(r.out, /greet\s+2 files, 1 KB\s+Say hello politely[\s\S]*Nothing written\. Run it in a terminal, or add --yes\./);
  assert.ok(!fs.existsSync(path.join(home, 'skills')));
  r = await run(['skills', 'add', 'someone/repo/skills', '--yes'], o);
  assert.match(r.out, /wrote .*skills.greet/);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'skills', 'greet'), { recursive: true }).sort(), ['SKILL.md', 'notes', path.join('notes', 'tone.md')]);
  assert.ok(!fs.existsSync(path.join(home, 'skills', 'other')));
  const bad = tmp('home');
  for (const [repo, why] of [['climbs', /^the archive holds a path that leaves its folder \(skills\/greet\/\.\.\/\.\.\/\.\.\/evil\.md\); nothing was written$/m], ['linked', /^the skill folder holds a link \(skills\/greet\/key\), which could point anywhere; nothing was written$/m], ['bomb', /^that archive unpacks to more than 32 MB, far more than skill folders need; nothing was written$/m]]) {
    r = await run(['skills', 'add', `someone/${repo}/skills`, '--yes'], { cwd: o.cwd, home: bad });
    assert.ok(r.code === 1 && why.test(r.out), r.out);
  }
  assert.deepStrictEqual(fs.readdirSync(bad), []);
  assert.match((await run(['skills'], o)).out, /\/greet +user +Say hello politely\n[\s\S]*\/review +built-in +Review the current changes/);
});

test('/diff shows what changed in a git folder', async () => {
  const cwd = tmp('diff'), git = (...a) => cp.spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...a], { cwd });
  git('init', '-q');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\n');
  git('add', '.'); git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'x');
  const r = await run(['-p', '/diff'], { cwd, home: tmp('home') });
  assert.match(r.out, / M a\.txt\n\s+\?\? new\.txt\n[\s\S]*\n\s+-one\n\s+\+two\n/);
  assert.match((await run(['-p', '/diff'], { cwd: tmp('nogit'), home: tmp('home') })).out, /not a git repository/);
});

// ---- interactive runs, through the SIBAC_TTY hook ----
test('first run: the menu survives "1" typed as an address; then Tab, the / menu, approvals with v / y / a / n, /undo, Ctrl+C', async () => {
  const cwd = tmp('inter'), home = tmp('home'), s = session([], { cwd, home });
  await s.expect(/1\) SIBA hosted +free, no key needed; runs open models \(default\)\n\s+2\) Groq +with my own key\n\s+3\) Another OpenAI-compatible endpoint/);
  await s.expect(/Choose 1, 2 or 3 \[1\]: /); s.send('groq\r');
  await s.expect(/Type 1, 2 or 3, or press Enter for 1\./);
  await s.expect(/Choose 1, 2 or 3 \[1\]: /); s.send('3\r');
  await s.expect(/Endpoint address: /); s.send('1\r');                                 // what the owner typed in 0.1.0
  await s.expect(/That is not a web address/);
  await s.expect(/Endpoint address: /); s.send(base('hosted') + '\r');
  await s.expect(/Model: /); s.send('\r');
  await s.expect(/Type the model name/);
  await s.expect(/Model: /); s.send('mock-model\r');
  await s.expect(/API key \[Enter for none\]: /); s.send('\r');
  await s.expect(/Saved in .*config\.json/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')), { baseUrl: base('hosted'), model: 'mock-model' });
  await s.expect(/╭─+╮[\s\S]*SIBA Code  v0\.2\.0[\s\S]*╰─+╯[\s\S]*› $/);

  s.send('/he\t');                                                                      // Tab completes the command
  await s.expect(/\/help/); s.send('\r');
  await s.expect(/\/undo\s+put back the files the last turn changed[\s\S]*Skills: .*\/review[\s\S]*› $/);
  s.send('/mo');                                                                        // the / menu lists what matches while typing
  await s.expect(/\/model  show the models, or switch with \/model <name>/);
  s.send(DEL + DEL + DEL + '\r');
  await s.expect(/› $/);

  s.send('make a file\r');
  await s.expect(/● Write made\.txt\n(    \+ line\d\n){8}\s+\.\.\. 4 more lines not shown\n  Allow\? y yes · a always this session · n no · v view all › $/);
  s.send('v\r');
  await s.expect(/(    \+ line\d+\n){12}  Allow\? /); s.send('y\r');
  await s.expect(/Made it\.[\s\S]*tokens · SIBA hosted · mock\/upstream-model[\s\S]*› $/);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'made.txt'), 'utf8'), twelve);

  s.send('edit it\r');
  await s.expect(/● Edit made\.txt\n    - line1\n    - \n    \+ LINE1\n    \+ \n  Allow\? /); s.send('a\r');
  await s.expect(/● Edit made\.txt\n    - line2[\s\S]*Edited twice\.[\s\S]*› $/);       // "always": the second edit of the turn does not ask
  assert.match(fs.readFileSync(path.join(cwd, 'made.txt'), 'utf8'), /^LINE1\nLINE2\nline3/);

  s.send('run it\r');
  await s.expect(/● Run echo should-not-run > ran\.txt\n  Allow\? y yes · n no · v view all › $/); s.send('a\r');   // no "always" for commands: "a" is a no
  await s.expect(/└ declined[\s\S]*You declined, so nothing ran\.[\s\S]*› $/);
  assert.ok(!fs.existsSync(path.join(cwd, 'ran.txt')));

  s.send('write outside\r');
  await s.expect(/Outside this folder\. Allow\? y yes · n no · v view all › $/); s.send('n\r');
  await s.expect(/It was declined\.[\s\S]*› $/);

  s.send('write SIBAC.md now\r');
  await s.expect(/● Write SIBAC\.md[\s\S]*Allow\? /); s.send(CTRL_C);                   // Ctrl+C at the approval prompt cancels the turn; nothing is written
  await s.expect(/Cancelled\.[\s\S]*› $/);
  assert.ok(!fs.existsSync(path.join(cwd, 'SIBAC.md')));
  s.send(ESC + '[A');                                                                    // the up arrow recalls what was typed at the prompt,
  await s.expect(/write SIBAC\.md now/); s.send(ESC + '[A');
  await s.expect(/write outside/); s.send(CTRL_C);                                       // not the "n" answered in between; Ctrl+C empties the line
  await sleep(200);

  s.send('/undo\r');                                                                    // the last turn that changed files: the two edits
  await s.expect(/restored made\.txt[\s\S]*› $/);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'made.txt'), 'utf8'), twelve);
  s.send('/undo\r');
  await s.expect(/restored made\.txt[\s\S]*› $/);
  assert.ok(!fs.existsSync(path.join(cwd, 'made.txt')), 'undoing the turn that created the file removes it');
  s.send('/undo\r');
  await s.expect(/Nothing to undo/);
  s.send('/diff\r');
  await s.expect(/not a git repository/);
  s.send('/status\r');
  await s.expect(/version\s+0\.2\.0\n\s+endpoint\s+http:\/\/127[\s\S]*key\s+none[\s\S]*tokens\s+about [\d,]+ this session[\s\S]*› $/);

  s.send('slow please\r');
  await s.expect(/Slow part 1/); s.send(CTRL_C);                                        // Ctrl+C in a reply cancels that reply only
  await s.expect(/Cancelled\.[\s\S]*› $/);
  assert.ok(!/Slow part 4/.test(text(s.raw())));
  s.send('still there?\r');
  await s.expect(/You said: still there\?[\s\S]*› $/);
  s.send('half a line' + CTRL_C);                                                       // at the prompt: first it empties the line,
  await sleep(200); s.send(CTRL_C);
  await s.expect(/Press Ctrl\+C again to leave\./); s.send(CTRL_C);                     // then it warns, then it leaves
  await s.expect(/Goodbye\./);
  assert.strictEqual(await s.exit(), 0);
  assert.ok(!of('hosted').some((q) => /half a line/.test(JSON.stringify(q.body))));
});
test('a broken saved endpoint is repaired by the menu; /model, siba-oak chat only, /login with a hidden key, /logout', async () => {
  const cwd = tmp('repair'), home = tmp('home'), conf = path.join(home, 'config.json'), key = 'sk_siba_TYPED_SECRET_42';
  fs.writeFileSync(conf, JSON.stringify({ baseUrl: '1', model: 'openai/gpt-oss-120b', apiKey: 'gsk_old_key_0123456789' }));
  const s = session([], { cwd, home });
  await s.expect(/The saved endpoint "1" is not a web address[\s\S]*Choose 1, 2 or 3 \[1\]: /); s.send('\r');
  await s.expect(/model   SIBA hosted · siba-code[\s\S]*› $/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(conf, 'utf8')), { baseUrl: base('hosted'), model: 'siba-code' });
  s.send('hello\r');
  await s.expect(/You said: hello[\s\S]*1,234 tokens · SIBA hosted · mock\/upstream-model[\s\S]*› $/);
  assert.strictEqual(of('hosted').at(-1).headers.authorization, undefined);

  s.send('/model\r');
  await s.expect(/siba-code\s+the coding agent[\s\S]*not a SIBA-trained one\n\s+siba-oak\s+SIBA's own small Azerbaijani model; chat only[\s\S]*› $/);
  s.send('/model gpt-9\r');
  await s.expect(/The hosted line has siba-code and siba-oak\./);
  s.send('/model siba-oak\r');
  await s.expect(/Model: siba-oak \(SIBA's own small Azerbaijani model; chat only/);
  s.send('salam\r');
  await s.expect(/Salam! Men SIBA Oak\.[\s\S]*SIBA hosted · siba-oak-3\.0 \(chat only\)[\s\S]*› $/);
  const oak = of('hosted').at(-1).body;
  assert.ok(oak.model === 'siba-oak' && oak.tools === undefined && oak.tool_choice === undefined && oak.messages.at(-1).role === 'user');
  assert.deepStrictEqual(oak.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  s.send('/init\r');
  await s.expect(/siba-oak is chat only/);

  s.send('/login\r');
  await s.expect(/Choose 1, 2 or 3 \[1\]: /); s.send('3\r');
  await s.expect(/Endpoint address: /); s.send(base('hosted') + '\r');
  await s.expect(/Model: /); s.send('siba-code\r');
  await s.expect(/API key \[Enter for none\]: /); s.send('qzx7\r');
  await s.expect(/does not look like a key/);
  await s.expect(/API key \[Enter for none\]: /); s.send(key + '\r');
  await s.expect(/Saved in[\s\S]*Now using SIBA hosted · siba-code\.[\s\S]*› $/);
  assert.ok(!s.raw().includes(key) && !s.raw().includes('qzx7'), 'a typed key is never echoed');
  assert.strictEqual(JSON.parse(fs.readFileSync(conf, 'utf8')).apiKey, key);
  s.send('with key\r');
  await s.expect(/You said: with key[\s\S]*› $/);
  assert.strictEqual(of('hosted').at(-1).headers.authorization, 'Bearer ' + key);
  s.send('/status\r');
  await s.expect(/key\s+saved \(not shown\)/);
  s.send('/logout\r');
  await s.expect(/The saved key is removed\. The hosted line needs none\./);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(conf, 'utf8')), { baseUrl: base('hosted'), model: 'siba-code' });
  s.send('without key\r');
  await s.expect(/You said: without key[\s\S]*› $/);
  assert.strictEqual(of('hosted').at(-1).headers.authorization, undefined);
  s.send((ESC + '[A').repeat(12));                                                       // the arrow-key history holds no key and no menu answer
  await s.expect(/hello/); s.send(CTRL_C);
  await sleep(200);
  s.send('/exit\r');
  await s.expect(/Goodbye\./);
  assert.strictEqual(await s.exit(), 0);
  assert.ok(!s.raw().includes(key) && !s.raw().includes('qzx7'));
});
test('/init writes the project guide and the next request carries it; /compact, /clear, /resume; @path completes', async () => {
  const cwd = tmp('guide'), home = tmp('home');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: base('hosted'), model: 'siba-code' }));
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'docs', 'road.md'), 'ship on friday');
  const s = session([], { cwd, home });
  await s.expect(/› $/);
  s.send('/init\r');
  await s.expect(/● Write SIBAC\.md[\s\S]*Allow\? /); s.send('y\r');
  await s.expect(/Wrote the guide\.[\s\S]*› $/);
  s.send('read @do\t');                                                                 // Tab completes a path after @
  await s.expect(/@docs\//); s.send('ro\t');
  await s.expect(/road\.md/); s.send('\r');
  await s.expect(/attached docs\/road\.md \(1 lines\)[\s\S]*You said: read @docs\/road\.md[\s\S]*› $/);
  const q = of('hosted').at(-1).body;
  assert.match(q.messages[0].content, /Project guide \(SIBAC\.md\):\n# Project\nRun: node hello\.js$/);
  assert.match(q.messages.at(-1).content, /<file path="docs\/road\.md">\nship on friday\n<\/file>$/);
  s.send('/compact\r');
  await s.expect(/Compacted: [\d,]+ characters in 6 messages became \d+\.[\s\S]*› $/);
  s.send('and now?\r');
  await s.expect(/You said: and now\?[\s\S]*› $/);
  assert.match(of('hosted').at(-1).body.messages[1].content, /^Summary of our conversation so far[\s\S]*SUMMARY: the user made a file\.$/);
  s.send('/clear\r');
  await s.expect(/Conversation cleared\./);
  s.send('/resume\r');
  await s.expect(/1\) .*Summary of our conversation so far.*\(3 messages\)\n\s+Number \(Enter leaves it\): /); s.send('1\r');
  await s.expect(/Reopened: Summary of our conversation[\s\S]*› $/);
  s.send('back again\r');
  await s.expect(/You said: back again[\s\S]*› $/);
  assert.strictEqual(of('hosted').at(-1).body.messages.length, 5);
  s.send('/exit\r');
  assert.strictEqual(await s.exit(), 0);
});
test('colour on: the logo is drawn in steps and the session still works; a key skips the animation', async () => {
  const home = tmp('home');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: base('hosted'), model: 'siba-code' }));
  const s = session([], { cwd: tmp('anim'), home, env: { NO_COLOR: null, COLORTERM: 'truecolor' } });
  await s.expect(/Describe a task in any language[\s\S]*› $/);
  const frames = s.raw().split(ESC + '[7A').length - 1;
  assert.ok(frames === 13 && s.raw().includes(ESC + '[38;2;46;134;224m') && s.raw().includes('███████ ██ ██████  ██   ██'), `13 logo frames in colour, got ${frames}`);
  s.send('hi\r');
  await s.expect(/You said: hi[\s\S]*› $/);
  s.send('/exit\r');
  assert.strictEqual(await s.exit(), 0);
  const quick = session([], { cwd: tmp('anim'), home, env: { NO_COLOR: null } });
  quick.send('x');
  await quick.expect(/Describe a task in any language[\s\S]*› /);
  assert.ok(quick.raw().split(ESC + '[7A').length - 1 < 13, 'typing ends the animation early');
  quick.send('/exit\r');                                                                // the key that skipped it is not left in the line
  assert.strictEqual(await quick.exit(), 0);
  const plainRun = session([], { cwd: tmp('anim'), home });
  await plainRun.expect(/› $/);
  assert.ok(!plainRun.raw().includes(ESC + '[7A') && !/\x1b\[\d+(;\d+)*m/.test(plainRun.raw()), 'NO_COLOR: no animation and no colour codes');
  plainRun.send('/exit\r');
  assert.strictEqual(await plainRun.exit(), 0);
});

// node e2e.js --serve [port] : only the stand-in endpoint, for driving sibac by hand or from e2e-pty.py
server.listen(process.argv[2] === '--serve' ? Number(process.argv[3]) || 0 : 0, '127.0.0.1', async () => {
  port = server.address().port;
  if (process.argv[2] === '--serve') return console.log(`SIBAC_HOSTED=http://127.0.0.1:${port}/hosted/v1`);
  let failed = 0;
  for (const [name, fn] of cases) {
    if (process.argv[2] && !name.includes(process.argv[2])) continue;
    try { await fn(); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n' + String(e.stack || e).split('\n').slice(0, 30).join('\n')); }
  }
  assert.ok(!log.some((r) => r.headers.origin), 'no request carries an Origin header');
  server.close();
  console.log(failed ? `${failed} failed` : 'e2e ok');
  process.exit(failed ? 1 : 0);
});
