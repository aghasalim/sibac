'use strict';
// What sibac prints: colour, model text made safe, light markdown, the spinner and the welcome screen.

// SIBAC_TTY=1 treats piped streams as a terminal, so the end-to-end test can drive the interactive paths.
const tty = () => process.env.SIBAC_TTY === '1' || !!process.stdout.isTTY;
const color = () => tty() && !process.env.NO_COLOR;
const paint = (n) => (s) => (color() ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = paint(2), bold = paint(1), red = paint(31), green = paint(32);
const BLUE = [46, 134, 224], CYAN = [63, 211, 222];   // SIBA brand blue and cyan (src/app/globals.css)
// 24-bit colour where the terminal says it can; the 216-colour cube elsewhere (older macOS Terminal reads 24-bit codes as background colours).
const deep = () => process.platform === 'win32' || /truecolor|24bit/i.test(process.env.COLORTERM || '');
const rgb = (c) => (s) => paint(deep() ? `38;2;${c.join(';')}` : `38;5;${16 + c.reduce((n, v) => n * 6 + Math.round(v / 51), 0)}`)(s);
const shade = (t) => rgb(BLUE.map((c, k) => Math.round(c + (CYAN[k] - c) * t)));   // 0 = blue, 1 = cyan
const accent = rgb(BLUE), cyan = rgb(CYAN);
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');   // text without colour codes, to measure its width
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Model text is untrusted: control codes (escape sequences, carriage returns) could repaint the screen and hide what is being approved.
// Covers control and invisible format characters too (bidi overrides, zero-width, line separators); only \n and \t pass.
const vis = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' || c === '\t' ? c : '\\' + 'u{' + c.codePointAt(0).toString(16) + '}'));

// Light markdown, one line at a time (st.code remembers an open code block). Runs after vis(), so the only colour codes are ours.
const mdLine = (line, st) => {
  const l = vis(line);
  if (/^\s*```/.test(l)) { st.code = !st.code; return dim(l); }
  if (st.code) return cyan(l);
  return l.replace(/^#{1,6}\s+(.*)$/, (_, t) => bold(t)).replace(/^(\s*)[-*]\s+/, '$1• ')
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t)).replace(/`([^`]+)`/g, (_, t) => cyan(t));
};
const md = (s) => { const st = {}; return String(s).split('\n').map((l) => mdLine(l, st)).join('\n'); };

// What a command returned, in one dim line: "exit 0 · first line of output (+N lines)".
const tail = (out) => {
  const l = vis(String(out).replace(/\r\n/g, '\n')).split('\n').filter((x) => x.trim());
  return dim('  └ ' + l.slice(0, 2).join(' · ').slice(0, 110) + (l.length > 2 ? `  (+${l.length - 2} lines)` : ''));
};

// The waiting line (terminal only): a dot and a label with a blue-to-cyan highlight running through it, and the seconds so far.
// print() writes a finished line above it, so streamed text and the indicator never overwrite each other.
function spinner(label) {
  if (!tty()) return { set() {}, print: (s) => console.log(s), stop() {} };
  const t0 = Date.now();
  let i = 0;
  const glow = (s) => (color()
    ? shade((1 + Math.sin(i / 3)) / 2)('●') + ' ' + [...s].map((c, k) => shade(Math.max(0, 1 - Math.abs(k - (i % (s.length + 8))) / 3))(c)).join('')
    : ['●∙∙', '∙●∙', '∙∙●', '∙●∙'][(i >> 1) % 4] + ' ' + s);
  // the label is cut to the window: a wrapped status line could not be erased again
  const draw = () => { process.stdout.write(`\r\x1b[2K  ${glow(label.slice(0, Math.max(8, (process.stdout.columns || 80) - 30)))}${dim(` ${Math.round((Date.now() - t0) / 1000)}s · Ctrl+C cancels`)}`); i++; };
  draw();
  const timer = setInterval(draw, 90);
  return {
    set(s) { label = s; },
    print(s) { process.stdout.write('\r\x1b[2K' + s + '\n'); draw(); },
    stop() { clearInterval(timer); process.stdout.write('\r\x1b[2K'); },
  };
}

// Prints the model's reply while it streams: whole lines only, so markdown and vis() see complete text.
function printer(sp) {
  const st = {};
  let buf = '', any = false, blank = true;
  const line = (raw) => {
    const l = raw.replace(/\r$/, ''), empty = !l.trim();
    if (empty && blank && !st.code) return;   // no leading or doubled blank lines
    if (!any) sp.print('');
    any = true; blank = empty;
    sp.print(mdLine(l, st));
  };
  return {
    push(t) { buf += t; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) line(buf.slice(0, i)); },
    end() { if (buf) line(buf); buf = ''; if (any && !blank) sp.print(''); },
  };
}

const LOGO = ['███████ ██ ██████   █████ ', '██      ██ ██   ██ ██   ██', '███████ ██ ██████  ███████', '     ██ ██ ██   ██ ██   ██', '███████ ██ ██████  ██   ██'];
// The welcome screen: logo and session facts in a frame; a two-line header when the window is narrow.
// animate: the logo is drawn left to right in about 0.4 s (skip() true ends it at once).
async function banner({ version, who, animate, skip = () => false }) {
  const cols = process.stdout.columns || 80, cwd = process.cwd();
  if (cols < 72) return console.log('\n  ' + accent('█ ') + bold('SIBA Code') + dim('  v' + version) + '\n  ' + dim(cwd) + '\n  ' + dim(who + ' · /help') + '\n');
  const R = Math.min(cols - 38, Math.max(34, 8 + cwd.length, 8 + who.length));   // width of the right-hand column; the frame stays two columns short of the window so no terminal wraps it
  const fit = (s) => (s.length > R - 8 ? '…' + s.slice(s.length - (R - 9)) : s);
  const info = [bold('SIBA Code') + dim('  v' + version), dim('Coding agent for your terminal'), '', dim('folder  ') + fit(cwd), dim('model   ') + fit(who)];
  const row = (l, r) => accent('│') + '  ' + l + '    ' + r + ' '.repeat(R - plain(r).length) + '  ' + accent('│');
  const logo = (w) => LOGO.map((l, i) => row(shade(i / 4)(l.slice(0, w)) + ' '.repeat(26 - w), info[i]));   // blue on the top row to cyan on the bottom
  const edge = (a, b) => accent(a + '─'.repeat(R + 34) + b), empty = row(' '.repeat(26), '');
  console.log('\n' + [edge('╭', '╮'), empty, ...logo(animate ? 0 : 26), empty, edge('╰', '╯')].join('\n'));
  for (let w = 2; animate && w <= 26; w += 2) {
    await sleep(30);
    if (skip()) w = 26;
    process.stdout.write('\x1b[7A' + logo(w).map((l) => '\r' + l + '\n').join('') + '\x1b[2B\r');   // up to the first logo row, redraw five rows, back below the frame
  }
  console.log(dim('  Describe a task in any language, for example ') + '"explain this project"' + dim(' or ') + '"fix the failing test"');
  console.log(dim('  /help commands · Tab completes · @file attaches a file · Ctrl+C cancels a reply\n'));
}

module.exports = { tty, color, dim, bold, red, green, accent, cyan, shade, plain, sleep, vis, md, mdLine, tail, spinner, printer, banner };
