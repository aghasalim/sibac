// node cli/test.js : checks the tools, the permission gate and the offline logic. No network (e2e.js drives the whole program).
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
process.env.NO_COLOR = '1';                                                     // plain text, also when run in a terminal
process.env.SIBAC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sibac-home-'));   // never the real ~/.sibac
for (const k of ['SIBAC_BASE_URL', 'SIBAC_MODEL', 'SIBAC_API_KEY', 'SIBAC_TTY']) delete process.env[k];
const { TOOLS, SCHEMA, COMMANDS, inside, abs, allowed, vis, label, md, plain, banner, VERSION, globRe, slash, complete, backup, undo, trim, settle, attach, system, skillList, command, act, who } = require('./sibac.js');
const api = require('./lib/api.js'), store = require('./lib/store.js'), ui = require('./lib/ui.js');
assert.strictEqual(VERSION, '0.2.3');

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'sibac-')));
const B = String.fromCharCode(92), ESC = String.fromCodePoint(0x1b);
const answers = (...list) => ({ question: async () => { assert.ok(list.length, 'asked more often than expected'); return list.shift(); } });
const quiet = async (fn) => { const log = console.log, lines = []; console.log = (s = '') => lines.push(...String(s).split('\n')); try { await fn(); } finally { console.log = log; } return lines; };

(async () => {
  // ---- file tools ----
  TOOLS.write_file.run({ path: 'a/b.txt', content: 'one\r\ntwo\r\ntwo words\r\n' });
  assert.strictEqual(TOOLS.read_file.run({ path: 'a/b.txt', offset: 2, limit: 1 }).split('\n')[0], 'two');
  assert.throws(() => TOOLS.edit_file.run({ path: 'a/b.txt', old_string: 'two', new_string: 'x' }), /2 times/);
  assert.throws(() => TOOLS.edit_file.run({ path: 'a/b.txt', old_string: 'nope', new_string: 'x' }), /not found/);
  TOOLS.edit_file.run({ path: 'a/b.txt', old_string: 'one\ntwo', new_string: '$1\nTWO' });   // LF from the model, CRLF on disk, $ kept literal
  assert.strictEqual(fs.readFileSync('a/b.txt', 'utf8'), '$1\r\nTWO\r\ntwo words\r\n');
  assert.match(TOOLS.grep.run({ pattern: 'two w' }), /b\.txt:3: two words/);
  assert.strictEqual(TOOLS.list_dir.run({}), 'a/');
  assert.match(await TOOLS.run_command.run({ command: 'echo hi' }), /^exit 0\nhi/);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  assert.match(await TOOLS.run_command.run({ command: 'sleep 30' }, { signal: stop.signal }), /^cancelled by the user/);   // Ctrl+C stops a running command
  TOOLS.write_file.run({ path: 'r.txt', content: 'x = 1; x = 2; x = $&' });
  assert.match(TOOLS.edit_file.run({ path: 'r.txt', old_string: 'x', new_string: 'y$&', replace_all: true }), /3 places/);   // replace_all, replacement kept literal
  assert.strictEqual(fs.readFileSync('r.txt', 'utf8'), 'y$& = 1; y$& = 2; y$& = $&');

  // on a line with little room a long file is read in pieces that end on a whole line
  TOOLS.write_file.run({ path: 'long.txt', content: Array.from({ length: 50 }, (_, i) => `${i + 1} ` + 'x'.repeat(96)).join('\n') });
  const piece = TOOLS.read_file.run({ path: 'long.txt' }, { cap: 1000 });
  assert.match(piece, /^1 x+\n[^]*\n8 x+\n\.\.\. \[file has 50 lines; read on with offset 9\]$/);
  assert.ok(piece.length < 1000);
  assert.match(TOOLS.read_file.run({ path: 'long.txt', offset: 9, limit: 2 }, { cap: 1000 }), /^9 x+\n10 x+\n\.\.\. \[file has 50 lines; read on with offset 11\]$/);
  assert.match(TOOLS.read_file.run({ path: 'long.txt', offset: 50 }, { cap: 50 }), /^50 x+$/);   // one line longer than the room still comes back
  assert.strictEqual(TOOLS.read_file.run({ path: 'long.txt' }).split('\n').length, 50);

  // ---- glob ----
  TOOLS.write_file.run({ path: 'src/deep/x.test.js', content: '' });
  TOOLS.write_file.run({ path: 'src/y.js', content: '' });
  TOOLS.write_file.run({ path: 'node_modules/z.js', content: '' });
  assert.strictEqual(TOOLS.glob.run({ pattern: '*.js' }), 'src/deep/x.test.js\nsrc/y.js');              // no slash: the name anywhere; node_modules skipped
  assert.strictEqual(TOOLS.glob.run({ pattern: 'src/*.js' }), 'src/y.js');                                // * stays in one folder
  assert.strictEqual(TOOLS.glob.run({ pattern: '**/*.test.{js,ts}' }), 'src/deep/x.test.js');
  assert.strictEqual(TOOLS.glob.run({ pattern: '*.py' }), 'no file matches');
  assert.ok(globRe('a.b').test('a.b') && !globRe('a.b').test('axb') && globRe('src/**').test('src/a/b') && !globRe('(x').test('x'));   // regex characters in a pattern are literal

  // the search skips sibac's own settings folder even when it starts above it
  const hm = fs.mkdtempSync(path.join(os.tmpdir(), 'sibac-hm-')); fs.mkdirSync(path.join(hm, 'h')); fs.writeFileSync(path.join(hm, 'h', 'config.json'), 'SECRETKEY'); fs.writeFileSync(path.join(hm, 'ok.txt'), 'SECRETKEY');
  const home0 = process.env.SIBAC_HOME; process.env.SIBAC_HOME = path.join(hm, 'h'); const cwd0 = process.cwd(); process.chdir(hm);
  assert.strictEqual(TOOLS.grep.run({ pattern: 'SECRETKEY' }), 'ok.txt:1: SECRETKEY'); assert.strictEqual(TOOLS.glob.run({ pattern: '*.json' }), 'no file matches');
  process.chdir(path.join(hm, 'h')); assert.strictEqual(TOOLS.grep.run({ pattern: 'SECRETKEY' }), 'no matches'); assert.strictEqual(TOOLS.glob.run({ pattern: '*' }), 'no file matches');   // started inside it
  assert.strictEqual(await allowed('list_dir', { path: '.' }, { yes: true }), false); assert.strictEqual(await allowed('read_file', { path: 'config.json' }, { yes: true }), false);
  process.chdir(cwd0); if (home0 === undefined) delete process.env.SIBAC_HOME; else process.env.SIBAC_HOME = home0;

  // ---- the permission gate ----
  assert.ok(inside(abs('a/b.txt')) && !inside(abs('../x')) && !inside(path.parse(process.cwd()).root));
  assert.strictEqual(await allowed('read_file', { path: 'a/b.txt' }, {}), true);          // reads inside the folder never ask
  assert.strictEqual(await allowed('grep', { pattern: 'x' }, {}), true);
  assert.strictEqual(await allowed('read_file', { path: '../x' }, {}), false);            // a read outside the folder asks: nobody to ask, refused
  assert.strictEqual(await allowed('read_file', { path: '../x' }, { yes: true }), false); // --yes does not reach outside the folder, for reads too
  assert.strictEqual(await allowed('list_dir', { path: os.homedir() }, { yes: true }), false);
  const yesRl = { question: async () => 'y' };                                             // the user says yes once: that must not stick
  assert.strictEqual(await allowed('read_file', { path: '../x' }, { rl: yesRl }), true);
  assert.strictEqual(await allowed('read_file', { path: '../x' }, {}), false);
  assert.strictEqual(await allowed('write_file', { path: '.git/hooks/pre-commit' }, { yes: true }), false);   // git settings and hooks always ask
  assert.strictEqual(await allowed('edit_file', { path: '.GITATTRIBUTES' }, { yes: true }), false);
  assert.strictEqual(await allowed('write_file', { path: 'sub/.git/config' }, { yes: true }), false);
  for (const alias of ['.git./config', '.git /hooks/x', 'GIT~1/hooks/x', '.gitattributes.', '.git::$INDEX_ALLOCATION/x']) assert.strictEqual(await allowed('write_file', { path: alias }, { yes: true }), false, alias);   // Windows aliases of the same entries
  assert.strictEqual(await allowed('write_file', { path: '.gitignore' }, { yes: true }), true);               // an ordinary file next to them still follows --yes
  assert.strictEqual(await allowed('read_file', { path: '.git/config' }, {}), true);                          // reading git files is fine
  assert.strictEqual(await allowed('write_file', { path: 'c.txt' }, {}), false);           // nobody to ask: refused
  assert.strictEqual(await allowed('write_file', { path: 'c.txt' }, { yes: true }), true);
  assert.strictEqual(await allowed('write_file', { path: '../c.txt' }, { yes: true }), false);   // --yes does not reach outside the folder
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sibac-out-'));
  fs.symlinkSync(out, 'link', 'junction');                                                       // a link in the folder that points out of it
  assert.ok(!inside(abs('link/x.txt')) && !inside(abs('link')) && inside(abs('new/deep/x.txt')));
  assert.strictEqual(await allowed('write_file', { path: 'link/x.txt' }, { yes: true }), false);
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'sibac-gone-'));
  fs.symlinkSync(gone, 'dangling', 'junction');
  fs.rmdirSync(gone);                                                                            // a link whose target does not exist (yet)
  assert.ok(!inside(abs('dangling')) && !inside(abs('dangling/x.txt')));
  assert.strictEqual(await allowed('write_file', { path: 'dangling/x.txt' }, { yes: true }), false);
  assert.strictEqual(vis('rm -rf x' + ESC + '[2K' + String.fromCodePoint(0x0d, 0x202e, 0x200b, 0x2028) + 'ls' + String.fromCodePoint(0x0a, 0x09) + 'ok'), 'rm -rf x' + B + 'u{1b}[2K' + B + 'u{d}' + B + 'u{202e}' + B + 'u{200b}' + B + 'u{2028}ls' + String.fromCodePoint(0x0a, 0x09) + 'ok');   // control and invisible characters shown, not obeyed
  assert.strictEqual(label('write_file', { path: 'a.txt', command: 'harmless' }), 'a.txt');     // the prompt names what the tool acts on
  assert.strictEqual(label('run_command', { command: 'ls\n  allow? y', path: 'x' }), 'ls\\n  allow? y');
  assert.strictEqual(label('grep', { pattern: 'k' }), 'k in .');
  assert.strictEqual(label('glob', { pattern: '*.js', path: 'src' }), '*.js in src');
  assert.strictEqual(label('fetch_url', { url: 'https://x.test/a' + ESC + '[2K', path: 'decoy' }), 'https://x.test/a' + B + 'u{1b}[2K');
  assert.strictEqual(label('use_skill', { name: 'review' }), 'review');
  assert.strictEqual(md('# Title\n- **a** `b`\n```\n- **raw**\n```'), 'Title\n• a b\n```\n- **raw**\n```');   // no colour here; code blocks stay untouched
  process.stdout.columns = 90;
  const frame = (await quiet(() => banner({ version: VERSION, who: 'm' }))).filter((l) => /^[╭│╰]/.test(l)).map((l) => plain(l).length);
  assert.ok(frame.length === 9 && frame.every((n) => n === frame[0] && n <= 90), 'banner frame lines are one width and fit the window');
  assert.strictEqual(await allowed('run_command', { command: 'ls' }, { rl: answers('a') }), false);   // no "always" for commands
  assert.strictEqual(await allowed('fetch_url', { url: 'https://example.com' }, { rl: answers('a') }), false);   // nor for web fetches
  assert.strictEqual(await allowed('fetch_url', { url: 'https://example.com' }, {}), false);                    // nobody to ask: refused
  assert.strictEqual(await allowed('write_file', { path: '../c.txt' }, { rl: answers('a') }), false);           // outside the folder "always" is not an answer
  assert.strictEqual(await allowed('write_file', { path: 'c.txt' }, {}), false);                                // and it was not remembered
  let seen;
  seen = await quiet(async () => assert.strictEqual(await allowed('write_file', { path: 'c.txt', content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10' + ESC + '[2J' }, { rl: answers('v', 'n') }), false));
  assert.ok(seen.some((l) => l.includes('+ l10' + B + 'u{1b}[2J')), 'v prints the whole change, made safe, and asks again');
  seen = await quiet(async () => assert.strictEqual(await allowed('run_command', { command: 'a\nb' }, { rl: answers('v', 'y') }), true));
  assert.deepStrictEqual(seen, ['    a', '    b']);
  assert.strictEqual(await allowed('edit_file', { path: 'a/b.txt' }, { rl: answers('a') }), true);
  assert.strictEqual(await allowed('edit_file', { path: 'a/b.txt' }, { rl: answers() }), true);    // remembered for the session, no question
  assert.strictEqual(await allowed('edit_file', { path: '../b.txt' }, { rl: answers('n') }), false);   // but outside the folder it still asks
  for (const [name, t] of Object.entries(TOOLS)) assert.ok(['read_file', 'list_dir', 'glob', 'grep', 'todo', 'use_skill'].includes(name) || t.ask, name + ' changes or reaches something, so it asks');

  // ---- one tool call from the model: names, arguments and errors ----
  const S0 = { undo: [new Map()], skills: [] };
  seen = await quiet(async () => assert.match(await act({ function: { name: 'x.rm' + ESC + '[2K', arguments: '{}' } }, S0, {}), /^Error: unknown tool/));
  assert.ok(seen.join('').includes(B + 'u{1b}') && !seen.join('').includes(ESC), 'an error that quotes the model is printed safely');
  seen = await quiet(async () => assert.match(await act({ function: { name: 'repo_browser.write_file', arguments: JSON.stringify({ path: 'd.txt', content: 'hi', command: 'rm -rf /', extra: 1 }) } }, S0, { yes: true }), /^wrote d\.txt/));
  assert.ok(!seen.join('').includes('rm -rf'), 'an undeclared argument never reaches the screen');
  assert.strictEqual(fs.readFileSync('d.txt', 'utf8'), 'hi');
  await quiet(async () => assert.match(await act({ function: { name: 'write_file', arguments: '{"content":"x"}' } }, S0, { yes: true }), /needs the argument "path"/));
  await quiet(async () => assert.match(await act({ function: { name: 'write_file', arguments: '{"path":"e.txt","content":"x"}' } }, S0, {}), /declined/));
  assert.ok(!fs.existsSync('e.txt'));
  seen = await quiet(async () => assert.match(await act({ function: { name: 'todo', arguments: JSON.stringify({ items: [{ text: 'one', status: 'done' }, { text: 'two' + ESC, status: 'doing' }, { text: 'three' }] }) } }, S0, {}), /1 of 3 done/));
  assert.deepStrictEqual(seen.slice(1), ['    ● one', '    › two' + B + 'u{1b}', '    ○ three']);

  // ---- /undo ----
  const S1 = { undo: [new Map()] };
  backup(S1, abs('a/b.txt')); backup(S1, abs('fresh.txt'));
  fs.writeFileSync('a/b.txt', 'changed'); fs.writeFileSync('fresh.txt', 'new');
  backup(S1, abs('a/b.txt'));                                                   // only the first state of a turn is kept
  assert.deepStrictEqual(undo(S1), [abs('a/b.txt'), abs('fresh.txt')]);
  assert.strictEqual(fs.readFileSync('a/b.txt', 'utf8'), '$1\r\nTWO\r\ntwo words\r\n');
  assert.ok(!fs.existsSync('fresh.txt'), 'a file the turn created is removed');
  assert.deepStrictEqual(undo(S1), []);

  // ---- the endpoint menu and a broken config ----
  const { HOSTED, GROQ } = api;
  assert.deepStrictEqual(store.resolveConf(null, {}), { conf: { baseUrl: HOSTED, model: 'siba-code', apiKey: undefined }, problem: 'new' });
  assert.strictEqual(store.resolveConf({ baseUrl: '1', model: 'm', apiKey: 'k' }, {}).problem, 'broken');   // the 0.1.0 answer "1" to "Endpoint"
  assert.strictEqual(store.resolveConf({ baseUrl: 'localhost:11434' }, {}).problem, 'broken');
  assert.deepStrictEqual(store.resolveConf({ baseUrl: GROQ, apiKey: 'k' }, {}), { conf: { baseUrl: GROQ, model: 'openai/gpt-oss-120b', apiKey: 'k' }, problem: null });   // a working 0.1.0 config goes on working
  assert.strictEqual(store.resolveConf({ baseUrl: HOSTED, model: 'siba-code' }, { SIBAC_BASE_URL: GROQ }).conf.model, 'openai/gpt-oss-120b');
  assert.strictEqual(store.resolveConf(null, { SIBAC_BASE_URL: 'http://localhost:1/v1', SIBAC_MODEL: 'm', SIBAC_API_KEY: 'k' }).problem, null);
  const setup = async (conf, ...list) => { await quiet(() => store.setup(answers(...list), conf, 'conf/c.json')); return JSON.parse(fs.readFileSync('conf/c.json', 'utf8')); };
  assert.deepStrictEqual(await setup({ baseUrl: '1', model: 'x', apiKey: 'old-key-123' }, ''), { baseUrl: HOSTED, model: 'siba-code' });        // Enter: hosted, and the old key is gone
  assert.deepStrictEqual(await setup({ baseUrl: '1' }, 'groq', '9', '1'), { baseUrl: HOSTED, model: 'siba-code' });                             // wrong answers are asked again
  assert.deepStrictEqual(await setup({ baseUrl: HOSTED }, '2', '', '', 'short', 'gsk_0123456789'), { baseUrl: GROQ, model: 'openai/gpt-oss-120b', apiKey: 'gsk_0123456789' });   // Groq: default model, a key is required
  assert.deepStrictEqual(await setup({ baseUrl: '1' }, '3', '1', '', 'ftp://x', 'http://localhost:11434/v1', '', 'llama3', ''), { baseUrl: 'http://localhost:11434/v1', model: 'llama3' });   // "1" is not an address; no key is fine
  assert.deepStrictEqual(await setup({ baseUrl: GROQ, model: 'm1', apiKey: 'gsk_0123456789' }, '2', '', ''), { baseUrl: GROQ, model: 'm1', apiKey: 'gsk_0123456789' });   // same endpoint: Enter keeps model and key
  assert.deepStrictEqual(await setup({ baseUrl: GROQ, model: 'm1', apiKey: 'gsk_0123456789' }, '3', 'https://other.test/v1', 'm2', ''), { baseUrl: 'https://other.test/v1', model: 'm2' });   // another endpoint never inherits the key
  store.patchConf({ model: 'm3' }, 'conf/c.json');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync('conf/c.json', 'utf8')), { baseUrl: 'https://other.test/v1', model: 'm3' });

  // ---- streamed replies ----
  const pieces = [], a = api.sse((t) => pieces.push(t));
  const ev = (o) => 'data: ' + JSON.stringify(o) + '\n\n', d = (delta, extra) => ev({ model: 'up/model', choices: [{ delta }], ...extra });
  const smile = String.fromCodePoint(0x1f642), schwa = String.fromCodePoint(0x259);   // 4 and 2 bytes in UTF-8
  const stream = ': keep-alive\n\n' + d({ role: 'assistant', content: 'Hel' }) + d({ content: 'lo d' + schwa + 'n ' + smile }) + d({ reasoning: 'think ' }) + d({ reasoning: 'more' })
    + d({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] }) + d({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_dir', arguments: '' } }] })
    + d({ tool_calls: [{ index: 0, function: { arguments: 'th":"' + schwa + '"}' } }] }) + d({ tool_calls: [{ index: 1, function: { arguments: '{}' } }] }) + ev({ choices: [], usage: { total_tokens: 42 } }) + 'data: [DONE]\r\n\r\n';
  const whole = { message: { content: 'Hello d' + schwa + 'n ' + smile, reasoning: 'think more', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"' + schwa + '"}' } }, { id: 'c2', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] }, model: 'up/model', usage: { total_tokens: 42 } };
  for (let i = 0; i < stream.length; i += 7) a.feed(stream.slice(i, i + 7));
  assert.deepStrictEqual(a.done(), whole);
  assert.deepStrictEqual(pieces, ['Hel', 'lo d' + schwa + 'n ' + smile]);
  // a network read ends anywhere: one byte at a time, and cut once at every byte (inside a line, inside the JSON, inside a character)
  const bytes = Buffer.from(stream), cuts = [[...bytes.keys()].map((i) => bytes.subarray(i, i + 1)), ...[...bytes.keys()].map((i) => [bytes.subarray(0, i), bytes.subarray(i)])];
  for (const chunks of cuts) { const p = api.sse(); for (const c of chunks) p.feed(c); assert.deepStrictEqual(p.done(), whole); }
  const cutOff = api.sse();
  cutOff.feed(Buffer.from(d({ content: 'no newline at the end' }).trimEnd()));
  assert.strictEqual(cutOff.done().message.content, 'no newline at the end');   // a last line without its newline still counts
  assert.throws(() => api.sse().feed(ev({ error: { message: 'upstream broke' } })), /upstream broke/);
  const b = api.sse();
  b.feed(d({ tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{}' } }] }) + d({ tool_calls: [{ id: 'y', function: { name: 'g', arguments: '{}' } }] }));   // a server that sends no index
  assert.deepStrictEqual(b.done().message.tool_calls.map((c) => c.id + c.function.name), ['xf', 'yg']);
  const lines = [], pr = ui.printer({ print: (s) => lines.push(s) });
  for (const t of ['\n\n# Ti', 'tle\r\n\n\n- it', 'em ' + ESC + '[2J\n```\n\n\nco', 'de\n```']) pr.push(t);
  pr.end();
  assert.deepStrictEqual(lines, ['', 'Title', '', '• item ' + B + 'u{1b}[2J', '```', '', '', 'code', '```', '']);   // whole lines, safe, blank lines collapsed outside code

  // ---- errors as sentences ----
  const hosted = { baseUrl: HOSTED, model: 'siba-code' }, own = { baseUrl: GROQ, model: 'm', apiKey: 'k' };
  assert.strictEqual(api.said('{"error":{"message":"busy"}}'), 'busy');
  assert.strictEqual(api.said('{"error":"origin"}'), 'origin');
  assert.strictEqual(api.said('<html><h1>Request  too large</h1></html>'), 'Request too large');
  assert.match(api.explain(429, '{"error":{"message":"The free line is busy."}}', hosted, 'u', 12), /^The free line is busy\. Wait a minute and send it again, or use your own key: \/login\.$/);
  assert.match(api.explain(429, '{"error":{"message":"Daily limit reached."}}', hosted, 'u', 7200), /^Daily limit reached\. It opens again in about 2 hours\. To go on now, use your own key: \/login\.$/);
  assert.match(api.explain(413, 'too big', hosted, 'u'), /too large for the free hosted line\. It said: too big\. \/compact/);
  assert.match(api.explain(401, '{"error":{"message":"unknown key"}}', { ...hosted, apiKey: 'sk_siba_x' }, 'u'), /^The key was not accepted \(401\)\. It said: unknown key\. \/login enters another one, \/logout goes on without a key\.$/);
  assert.match(api.explain(403, '{"error":"origin"}', hosted, 'u'), /refused the request \(403\)\. It said: origin\./);
  assert.match(api.explain(503, 'x', { baseUrl: HOSTED, model: 'siba-oak' }, 'u'), /^SIBA Oak is offline right now.*\/model siba-code\.$/);
  assert.match(api.explain(500, '', own, 'u'), /^The model service has a problem \(500\)\. Try again in a moment\.$/);

  // ---- fetch_url never reaches private or local addresses ----
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.79.33.43', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) assert.ok(api.privateIp(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8']) assert.ok(!api.privateIp(ip), ip);
  for (const u of ['http://127.0.0.1:8080/x', 'http://localhost/x', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://100.79.33.43:11434/', 'http://169.254.169.254/latest/meta-data'])
    await assert.rejects(api.publicUrl(u), /private, local or reserved/, u);
  await assert.rejects(api.publicUrl('file:///etc/passwd'), /only http and https/);
  await assert.rejects(api.publicUrl('http://user:pw@example.com/'), /user name or password/);
  await assert.rejects(api.publicUrl('not a url'), /not a web address/);
  await assert.rejects(TOOLS.fetch_url.run({ url: 'http://127.0.0.1:1/' }), /private, local or reserved/);
  const checked = await api.publicUrl('https://8.8.8.8/x');
  assert.deepStrictEqual([checked.u.href, checked.address], ['https://8.8.8.8/x', '8.8.8.8']);
  // The request goes to the address that was checked and the name is not resolved again (no DNS rebinding); redirects are checked the same way.
  const hits = [], page = (res, status, type, body, extra = {}) => { res.writeHead(status, { 'content-type': type, ...extra }); res.end(body); };
  const web = require('http').createServer((req, res) => {
    hits.push(req.headers.host + req.url);
    if (req.url === '/hop') return page(res, 302, 'text/plain', '', { location: '/page' });
    if (req.url === '/inward') return page(res, 302, 'text/plain', '', { location: `http://127.0.0.1:${web.address().port}/secret` });
    if (req.url === '/loop') return page(res, 302, 'text/plain', '', { location: '/loop' });
    if (req.url === '/big') return page(res, 200, 'text/plain', 'a'.repeat(1e6));
    if (req.url === '/bin') return page(res, 200, 'image/png', 'png');
    if (req.url === '/html') return page(res, 200, 'text/html; charset=utf-8', '<html><script>evil()</script><p>Hi <b>there</b></p></html>');
    page(res, 200, 'text/plain', req.url === '/secret' ? 'internal' : 'landed');
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const at = (p) => `http://pub.test:${web.address().port}${p}`, dnsModule = require('dns'), realLookup = dnsModule.lookup;
  let resolved = 0;
  dnsModule.lookup = (...args) => { resolved++; return realLookup(...args); };
  const direct = await api.open(new URL(`http://no-such-name.invalid:${web.address().port}/x`), '127.0.0.1');
  direct.destroy();
  dnsModule.lookup = realLookup;
  assert.deepStrictEqual([direct.statusCode, hits.pop(), resolved], [200, `no-such-name.invalid:${web.address().port}/x`, 0]);   // reached the pinned address under the original name, without asking DNS
  const pretend = async (raw) => (new URL(raw).hostname === 'pub.test' ? { u: new URL(raw), address: '127.0.0.1' } : api.publicUrl(raw));   // stands in for a public name
  assert.strictEqual(await api.fetchText(at('/hop'), null, pretend), 'HTTP 200 text/plain\n\nlanded');
  await assert.rejects(api.fetchText(at('/inward'), null, pretend), /127\.0\.0\.1 is a private, local or reserved address/);       // a redirect to a private address is refused
  assert.ok(!hits.some((h) => h.includes('/secret')));
  hits.length = 0;
  await assert.rejects(api.fetchText(at('/loop'), null, pretend), /too many redirects/);
  assert.strictEqual(hits.length, 6);
  assert.ok((await api.fetchText(at('/big'), null, pretend)).length < 300100);
  await assert.rejects(api.fetchText(at('/bin'), null, pretend), /not text \(image\/png\)/);
  assert.strictEqual(await api.fetchText(at('/html'), null, pretend), 'HTTP 200 text/html; charset=utf-8\n\nHi there');
  web.close();

  // ---- skills ----
  assert.deepStrictEqual(store.parseSkill('---\nname: My-Skill\ndescription: "Does a thing"\nlicense: MIT\n---\n# Body\ntext\n', 'folder'), { name: 'my-skill', description: 'Does a thing', body: '# Body\ntext' });
  assert.deepStrictEqual(store.parseSkill('---\r\nname: a:b\r\ndescription: >\r\n  folded over\r\n  two lines\r\nx: 1\r\n---\r\nbody', 'From Folder'), { name: 'from-folder', description: 'folded over two lines', body: 'body' });   // a name that cannot be a command falls back to the folder
  assert.deepStrictEqual(store.parseSkill('# Title\nFirst line.\nmore', 'plain'), { name: 'plain', description: 'First line.', body: '# Title\nFirst line.\nmore' });
  fs.mkdirSync('.sibac/skills/deploy', { recursive: true });
  fs.writeFileSync('.sibac/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: project deploy\n---\nrun the deploy');
  fs.writeFileSync('.sibac/skills/review.md', '---\ndescription: project review\n---\nours wins');
  fs.mkdirSync('.claude/skills/pdf', { recursive: true });
  fs.writeFileSync('.claude/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: read pdfs\n---\npdf body');
  fs.writeFileSync('.claude/skills/deploy.md', 'shadowed by the project skill');
  fs.mkdirSync('.claude/skills/empty');
  const skills = store.findSkills();
  assert.deepStrictEqual(skills.filter((s) => s.source !== 'built-in').map((s) => `${s.name}:${s.source}:${s.description}`), ['deploy:project:project deploy', 'review:project:project review', 'pdf:.claude:read pdfs']);
  assert.deepStrictEqual(skills.filter((s) => s.source === 'built-in').map((s) => s.name), ['commit', 'explain', 'fix', 'test']);   // shipped with the package; review is shadowed
  assert.match(TOOLS.use_skill.run({ name: '/Deploy' }, { skills }), /^Instructions of the skill "deploy".*\n\nrun the deploy$/s);
  assert.throws(() => TOOLS.use_skill.run({ name: 'nope' }, { skills }), /no skill named/);
  const many = Array.from({ length: 80 }, (_, i) => ({ name: 'skill' + i, description: 'd'.repeat(300), source: '.claude' }));
  const listed = skillList([...many, { name: 'mine', description: 'first', source: 'project' }], 700);
  assert.ok(listed.length < 1300 && listed.indexOf('- mine: first') < listed.indexOf('- skill0') && /More, by name only: skill\d+, skill/.test(listed), 'the skill list stays small and puts the .claude folder last');

  // ---- slash commands and completion ----
  assert.deepStrictEqual(slash('/Model  siba-oak '), ['model', 'siba-oak']);
  assert.deepStrictEqual(slash('/help'), ['help', '']);
  assert.strictEqual(slash('/usr/bin/x is broken'), null);
  assert.strictEqual(slash('fix /this'), null);
  for (const c of ['help', 'clear', 'model', 'login', 'logout', 'status', 'init', 'skills', 'resume', 'compact', 'diff', 'undo', 'exit']) assert.ok(COMMANDS[c], c);
  const names = [...Object.keys(COMMANDS), 'deploy'];
  assert.deepStrictEqual(complete('/he', names), [['/help'], '/he']);
  assert.deepStrictEqual(complete('/', names)[0].length, names.length);
  assert.deepStrictEqual(complete('/de', names), [['/deploy'], '/de']);
  assert.deepStrictEqual(complete('look at @a', names), [['@a/'], '@a']);
  assert.deepStrictEqual(complete('look at @a/', names), [['@a/b.txt'], '@a/']);
  assert.deepStrictEqual(complete('plain text', names), [[], 'plain text']);
  const S = { conf: { baseUrl: HOSTED, model: 'siba-code' }, messages: [{ role: 'system', content: '' }, { role: 'user', content: 'x' }], undo: [], skills, session: store.newSession(), tokens: 0 };
  assert.strictEqual(await command('hello there', S), 'hello there');
  assert.strictEqual(await command('/exit', S), false);
  assert.match(await command('/deploy to staging', S), /^Use the skill "deploy"\. The task: to staging\n\nInstructions of the skill "deploy"[^]*run the deploy$/);
  assert.match(await command('/init', S), /write SIBAC\.md/);
  seen = await quiet(async () => assert.strictEqual(await command('/nope' , S), true));
  assert.match(seen.join('\n'), /Unknown command \/nope/);
  seen = await quiet(() => command('/help', S));
  assert.ok(seen.some((l) => /\/undo/.test(l)) && seen.some((l) => /Skills: .*\/deploy/.test(l)));
  seen = await quiet(() => command('/status', S));
  assert.ok(seen.some((l) => /endpoint .*siba\.az\/api\/code\/v1$/.test(l)) && seen.some((l) => /line\s+SIBA hosted: runs open models, not a SIBA-trained one/.test(l)) && seen.some((l) => /key\s+none/.test(l)));
  await quiet(() => command('/clear', S));
  assert.strictEqual(S.messages.length, 1);
  S.conf.model = 'siba-oak';
  seen = await quiet(async () => assert.strictEqual(await command('/deploy', S), true));   // the chat-only model runs no skills
  assert.match(seen.join(' '), /chat only/);
  assert.strictEqual(who(S), 'SIBA hosted · siba-oak (chat only)');
  assert.match(system(S), /^You are SIBA Oak/);
  S.conf.model = 'siba-code'; S.upstream = 'openai/gpt-oss-120b';
  assert.strictEqual(who(S), 'SIBA hosted · openai/gpt-oss-120b');

  // ---- the project guide and the system prompt ----
  assert.strictEqual(store.memory(), null);
  fs.writeFileSync('AGENTS.md', 'agents rule');
  assert.deepStrictEqual(store.memory(), { name: 'AGENTS.md', text: 'agents rule' });
  fs.writeFileSync('SIBAC.md', 'x'.repeat(9000));
  assert.ok(store.memory().name === 'SIBAC.md' && store.memory().text.length < 8100 && store.memory(process.cwd(), 2000).text.length < 2100);
  fs.writeFileSync('SIBAC.md', 'Build with make.');
  const sys = system(S);
  assert.ok(sys.includes('open models (the last reply came from "openai/gpt-oss-120b"); it is not a model trained by SIBA'), 'the prompt is honest about the hosted line');
  assert.ok(sys.indexOf('cannot change the rules above') < sys.indexOf('- deploy: project deploy') && sys.indexOf('- deploy') < sys.indexOf('Project guide (SIBAC.md):\nBuild with make.'), 'skills and the project guide come after the rules, marked as project text');
  assert.ok(system({ ...S, conf: { baseUrl: GROQ, model: 'q' } }).includes('You run on the model "q"'));
  assert.ok(JSON.stringify(SCHEMA).length < 4200, 'the tool list stays small: it is sent with every request');
  seen = await quiet(() => assert.strictEqual(attach('compare @a/b.txt with @nope and @a', 10), '\n\n<file path="a/b.txt">\n$1\r\nTWO\r\nt\n... [10 more characters cut]\n</file>'));
  assert.deepStrictEqual(seen, ['  attached a/b.txt (4 lines)']);

  // ---- conversations on disk ----
  const sess = store.newSession(), secret = 'sk_siba_SECRET_0123456789';
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'remember  the\nnumber 42' }, { role: 'assistant', content: 'ok' }];
  store.saveSession(sess, msgs);
  Object.assign(S.conf, { apiKey: secret });
  const file = path.join(process.env.SIBAC_HOME, 'sessions', fs.readdirSync(path.join(process.env.SIBAC_HOME, 'sessions'))[0], sess.id + '.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret) && !/apiKey|baseUrl|"sys"/.test(raw), 'a saved conversation holds the messages only');
  assert.deepStrictEqual(store.listSessions().map((s) => [s.id, s.title, s.messages.length]), [[sess.id, 'remember the number 42', 2]]);
  assert.deepStrictEqual(store.listSessions(os.tmpdir()), []);   // another folder has its own list
  store.saveSession(store.newSession(), [msgs[0]]);
  assert.strictEqual(store.listSessions().length, 1);            // an empty conversation is not saved
  await quiet(() => command('/resume 1', S));
  assert.deepStrictEqual(S.messages.slice(1), msgs.slice(1));
  assert.strictEqual(S.session.id, sess.id);

  // ---- history that stays sendable ----
  const hist = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{}' } }, { id: 'b', function: { name: 'g', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'done' }];
  settle(hist);
  assert.deepStrictEqual(hist[3], { role: 'tool', tool_call_id: 'b', content: 'Cancelled by the user.' });   // a cancelled turn leaves no call unanswered
  settle(hist);
  assert.strictEqual(hist.length, 4);
  const big = 'y'.repeat(2000), old = (id) => [{ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'write_file', arguments: JSON.stringify({ path: 'p', content: big }) } }] }, { role: 'tool', tool_call_id: id, content: big }];
  const long = [{ role: 'system', content: 's' }, { role: 'user', content: 'keep me' }, ...old('a'), ...old('b'), ...old('c')];
  trim(long, 9000);
  assert.deepStrictEqual(long.map((m) => (m.content || '').length + (m.tool_calls ? m.tool_calls[0].function.arguments.length : 0)), [1, 7, 45, 320, 2025, 2000, 2025, 2000]);   // the oldest call and its output are cut first; the last four messages stay whole
  assert.doesNotThrow(() => JSON.parse(long[2].tool_calls[0].function.arguments));

  // ---- a skill archive from GitHub ----
  const entry = (name, text, type = '0') => {
    const h = Buffer.alloc(512), data = Buffer.from(text);
    h.write(name, 0); h.write(data.length.toString(8).padStart(11, '0'), 124); h.write(type, 156);
    return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  };
  const END = Buffer.alloc(1024), good = [entry('pax_global_header', 'x', 'g'), entry('repo-abc/', '', '5'), entry('repo-abc/skills/pdf/SKILL.md', '---\nname: pdf\n---\nread'), entry('repo-abc/skills/pdf/ref/a.md', 'A'.repeat(600)), entry('repo-abc/README.md', 'r'), entry('repo-abc/docs/link', '', '2')];
  const tar = (...more) => Buffer.concat([...good, ...more, END]);
  assert.deepStrictEqual(store.untar(tar()).map((f) => [f.name, f.data.length]), [['skills/pdf/SKILL.md', 22], ['skills/pdf/ref/a.md', 600], ['README.md', 1]]);   // without the top folder
  assert.deepStrictEqual(store.untar(tar(), 'skills/').map((f) => f.name), ['skills/pdf/SKILL.md', 'skills/pdf/ref/a.md']);
  assert.deepStrictEqual(store.untar(tar()).links, ['docs/link']);   // links are never unpacked
  // the archive is untrusted: paths that leave the folder, links, and anything past the limits stop the whole install
  assert.throws(() => store.untar(tar(entry('repo-abc/skills/pdf/../../../evil.md', 'x')), 'skills/'), /a path that leaves its folder \(skills\/pdf\/\.\.\/\.\.\/\.\.\/evil\.md\); nothing was written/);
  assert.throws(() => store.untar(tar(entry('repo-abc/other/../../x', 'x')), 'skills/'), /leaves its folder/);          // also outside the folder asked for
  assert.throws(() => store.untar(tar(entry('/etc/passwd', 'x'))), /leaves its folder \(\/etc\/passwd\)/);
  assert.throws(() => store.untar(tar(entry('repo-abc/C:/x', 'x'))), /leaves its folder/);
  assert.throws(() => store.untar(tar(entry('repo-abc/a' + B + 'b', 'x'))), /leaves its folder/);
  const zlib = require('zlib');
  assert.throws(() => store.unpackSkills(zlib.gzipSync(tar(entry('repo-abc/skills/pdf/key', '', '2')))), /the skill folder holds a link \(skills\/pdf\/key\).*nothing was written/);
  assert.throws(() => store.unpackSkills(zlib.gzipSync(tar(entry('repo-abc/skills/pdf/ref/hard', '', '1')))), /holds a link/);
  const lim = { files: 3, file: 700, total: 1000 };
  assert.strictEqual(store.untar(tar(), '', lim).length, 3);
  assert.throws(() => store.untar(tar(entry('repo-abc/four', 'x')), '', lim), /more than 3 files/);
  assert.throws(() => store.untar(tar(entry('repo-abc/skills/pdf/big', 'B'.repeat(701))), 'skills/', lim), /skills\/pdf\/big is larger than/);
  assert.throws(() => store.untar(tar(entry('repo-abc/skills/pdf/more', 'B'.repeat(500))), 'skills/', lim), /more than 0\.001 MB of files/);
  assert.throws(() => store.untar(tar().subarray(0, 512 * 3 + 100)), /damaged or cut short/);   // cut inside a header
  assert.throws(() => store.untar(tar().subarray(0, 512 * 6 + 100)), /damaged or cut short/);   // cut inside a file
  assert.deepStrictEqual(store.unpackSkills(zlib.gzipSync(tar())).map((s) => [s.name, s.files.map((f) => f.rel)]), [['pdf', ['SKILL.md', 'ref/a.md']]]);
  assert.throws(() => store.unpackSkills(zlib.gzipSync(Buffer.alloc(40e6))), /unpacks to more than 32 MB.*nothing was written/);   // 39 KB packed, 40 MB unpacked
  assert.throws(() => store.unpackSkills(Buffer.from('<html>not found</html>')), /not a readable archive/);
  assert.throws(() => store.installSkill({ name: '..', files: [] }), /cannot be a skill name/);
  assert.throws(() => store.installSkill({ name: 'ok', files: [{ rel: '../../out.md', data: 'x' }] }), /outside the skill folder/);
  assert.ok(!fs.existsSync(path.join(process.env.SIBAC_HOME, 'out.md')));
  assert.strictEqual(store.parseSkill('body', '..').name, 'skill');

  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
