// node cli/test.js : checks the file tools and the permission gate, no network.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { TOOLS, inside, abs, allowed, vis, label, md, plain, banner, firstRun, VERSION } = require('./sibac.js');
assert.strictEqual(VERSION, require('./package.json').version);

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'sibac-')));
(async () => {
  TOOLS.write_file.run({ path: 'a/b.txt', content: 'one\r\ntwo\r\ntwo words\r\n' });
  assert.strictEqual(TOOLS.read_file.run({ path: 'a/b.txt', offset: 2, limit: 1 }).split('\n')[0], 'two');
  assert.throws(() => TOOLS.edit_file.run({ path: 'a/b.txt', old_string: 'two', new_string: 'x' }), /2 times/);
  assert.throws(() => TOOLS.edit_file.run({ path: 'a/b.txt', old_string: 'nope', new_string: 'x' }), /not found/);
  TOOLS.edit_file.run({ path: 'a/b.txt', old_string: 'one\ntwo', new_string: '$1\nTWO' });   // LF from the model, CRLF on disk, $ kept literal
  assert.strictEqual(fs.readFileSync('a/b.txt', 'utf8'), '$1\r\nTWO\r\ntwo words\r\n');
  assert.match(TOOLS.grep.run({ pattern: 'two w' }), /b\.txt:3: two words/);
  assert.strictEqual(TOOLS.list_dir.run({}), 'a/');
  assert.match(TOOLS.run_command.run({ command: 'echo hi' }), /^exit 0\nhi/);

  assert.ok(inside(abs('a/b.txt')) && !inside(abs('../x')) && !inside(path.parse(process.cwd()).root));
  assert.strictEqual(await allowed('read_file', { path: '../x' }, {}), true);              // reads never ask
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
  const B = String.fromCharCode(92);
  assert.strictEqual(vis('rm -rf x' + String.fromCodePoint(0x1b) + '[2K' + String.fromCodePoint(0x0d, 0x202e, 0x200b, 0x2028) + 'ls' + String.fromCodePoint(0x0a, 0x09) + 'ok'), 'rm -rf x' + B + 'u{1b}[2K' + B + 'u{d}' + B + 'u{202e}' + B + 'u{200b}' + B + 'u{2028}ls' + String.fromCodePoint(0x0a, 0x09) + 'ok');   // control and invisible characters shown, not obeyed
  assert.strictEqual(label('write_file', { path: 'a.txt', command: 'harmless' }), 'a.txt');     // the prompt names what the tool acts on
  assert.strictEqual(label('run_command', { command: 'ls\n  allow? y', path: 'x' }), 'ls\\n  allow? y');
  assert.strictEqual(label('grep', { pattern: 'k' }), 'k in .');
  assert.strictEqual(md('# Title\n- **a** `b`\n```\n- **raw**\n```'), 'Title\n• a b\n```\n- **raw**\n```');   // not a terminal here, so no colour codes; code blocks stay untouched
  const logged = [], log = console.log;
  console.log = (s) => logged.push(...String(s).split('\n'));
  process.stdout.columns = 90;
  banner({ model: 'm' });
  console.log = log;
  const frame = logged.filter((l) => /^[╭│╰]/.test(l)).map((l) => plain(l).length);
  assert.ok(frame.length === 9 && frame.every((n) => n === frame[0] && n <= 90), 'banner frame lines are one width and fit the window');
  const rl = (answer) => ({ question: async () => answer });
  assert.strictEqual(await allowed('run_command', { command: 'ls' }, { rl: rl('a') }), false);   // no "always" for commands
  assert.strictEqual(await allowed('edit_file', { path: 'a/b.txt' }, { rl: rl('a') }), true);
  assert.strictEqual(await allowed('edit_file', { path: 'a/b.txt' }, { rl: rl('n') }), true);    // remembered for the session
  const answers = ['', 'my-model', ' my-key '], quiet = console.log;
  console.log = () => {};
  await firstRun({ question: async () => answers.shift() }, { baseUrl: 'https://x/v1', model: 'd' }, 'conf/c.json');   // Enter keeps the default
  assert.deepStrictEqual(JSON.parse(fs.readFileSync('conf/c.json', 'utf8')), { baseUrl: 'https://x/v1', model: 'my-model', apiKey: 'my-key' });
  await assert.rejects(firstRun({ question: async () => '' }, { baseUrl: 'b', model: 'm' }, 'conf/d.json'), /no key/);
  console.log = quiet;
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
