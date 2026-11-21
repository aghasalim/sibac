// Builds docs/terminal.svg from the real banner text. Run: node docs/make.js
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const logo = ['███████ ██ ██████   █████ ', '██      ██ ██   ██ ██   ██', '███████ ██ ██████  ███████', '     ██ ██ ██   ██ ██   ██', '███████ ██ ██████  ██   ██'];
const L = []; // [x(chars), y(line), text, class]
let y = 0;
const t = (x, s, c = 'f') => L.push([x, y, s, c]);
const nl = (n = 1) => { y += n; };
t(0, '╭' + '─'.repeat(68) + '╮', 'b'); nl();
nl();
logo.forEach((r, i) => {
  t(2, r, 'a');
  if (i === 0) { t(31, 'SIBA Code', 'w'); t(42, 'v0.2.3', 'd'); }
  if (i === 1) t(31, 'Coding agent for your terminal', 'f');
  if (i === 3) { t(31, 'folder', 'd'); t(39, '~/my-project', 'f'); }
  if (i === 4) { t(31, 'model', 'd'); t(39, 'SIBA hosted · siba-code', 'f'); }
  nl();
});
nl();
t(0, '╰' + '─'.repeat(68) + '╯', 'b'); nl();
t(2, 'Describe a task in any language, for example "explain this project" or "fix the failing test"', 'd'); nl();
t(2, '/help commands · Tab completes · @file attaches a file · Ctrl+C cancels a reply', 'd'); nl(2);
t(0, '›', 'a'); t(2, 'fix the failing test in tests/', 'w'); nl(2);
t(2, '◆ run_command', 'a'); t(16, 'npm test', 'f'); nl();
t(4, 'Run this command?  [y] yes  [n] no', 'y'); nl(2);
t(2, 'The test expected 3 items but the loop stops at 2. I will change the range in', 'f'); nl();
t(2, 'src/list.js and run the tests again.', 'f'); nl(2);
t(2, '◆ edit_file', 'a'); t(15, 'src/list.js', 'f'); nl();
t(4, 'Change this file?  [y] yes  [a] always  [n] no  [v] view', 'y'); nl();
const cw = 8.4, lh = 21, pad = 24, W = 68 * cw + 2 * pad + 12, H = (y + 1) * lh + 2 * pad + 28;
const out = L.map(([x, yy, s, c]) => `<text class="${c}" x="${(pad + x * cw).toFixed(1)}" y="${pad + 28 + (yy + 1) * lh - 6}" xml:space="preserve">${esc(s)}</text>`).join('\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="The sibac start screen and an example task">
<style>text{font:14px 'Cascadia Mono',Consolas,Menlo,'DejaVu Sans Mono',monospace}.f{fill:#e6edf3}.d{fill:#8b98a5}.w{fill:#fff;font-weight:700}.a{fill:#3da9fc}.b{fill:#3b4a5a}.y{fill:#e3b341}</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect width="${W}" height="28" rx="10" fill="#161b22"/><rect y="18" width="${W}" height="10" fill="#161b22"/>
<circle cx="18" cy="14" r="5" fill="#ff5f56"/><circle cx="36" cy="14" r="5" fill="#ffbd2e"/><circle cx="54" cy="14" r="5" fill="#27c93f"/>
${out}
</svg>`;
require('fs').writeFileSync(__dirname + '/terminal.svg', svg);
