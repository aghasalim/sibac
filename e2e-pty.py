#!/usr/bin/env python3
# python3 cli/e2e-pty.py : the interactive paths of sibac in a REAL pseudo-terminal, without the SIBAC_TTY hook that e2e.js uses.
# Linux and macOS only (Python's pty module); on Windows run it inside WSL. Needs node and python3. Not shipped in the package.
# It starts the stand-in endpoint of e2e.js, then types into sibac like a person: menu, Tab, approval with v and y, a hidden key, Ctrl+C.
import fcntl, os, pty, re, select, struct, subprocess, sys, tempfile, termios, time

here = os.path.dirname(os.path.abspath(__file__))
mock = subprocess.Popen(['node', os.path.join(here, 'e2e.js'), '--serve'], stdout=subprocess.PIPE, text=True)
hosted = mock.stdout.readline().strip().split('=', 1)[1]
home, cwd = tempfile.mkdtemp(prefix='sibac-pty-home-'), tempfile.mkdtemp(prefix='sibac-pty-')
env = dict(os.environ, SIBAC_HOME=home, SIBAC_HOSTED=hosted, COLORTERM='truecolor', TERM='xterm-256color')
for k in ('SIBAC_TTY', 'NO_COLOR', 'SIBAC_BASE_URL', 'SIBAC_MODEL', 'SIBAC_API_KEY'):
    env.pop(k, None)

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))   # a 100 x 40 window
    os.chdir(cwd)
    os.execvpe('node', ['node', os.path.join(here, 'sibac.js')], env)

raw, seen = b'', 0
def text():
    return re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', raw.decode('utf8', 'replace')).replace('\r\n', '\n')   # the terminal turns \n into \r\n
def expect(pattern, timeout=20):
    global raw, seen
    end = time.time() + timeout
    while time.time() < end:
        m = re.search(pattern, text()[seen:])
        if m:
            seen += m.end()
            return m
        if select.select([fd], [], [], 0.05)[0]:
            try:
                raw += os.read(fd, 65536)
            except OSError:
                break
    sys.exit('FAIL: waited for %r, but the terminal went on with:\n%s' % (pattern, text()[seen:][-1200:]))
def send(keys):
    os.write(fd, keys.encode())

try:
    expect(r'Choose 1, 2 or 3 \[1\]: '); send('\r')                       # first run: Enter takes the hosted line
    expect(r'model   SIBA hosted · siba-code[\s\S]*› $')
    assert raw.count(b'\x1b[7A') == 13 and b'\x1b[38;2;46;134;224m' in raw, 'the logo is animated in colour on a real terminal'
    send('/he\t'); expect(r'/help'); send('\r')                            # Tab completes
    expect(r'/undo\s+put back the files[\s\S]*› $')
    send('/mo'); expect(r'/model  show the models'); send('\x7f\x7f\x7f')  # the / menu, then backspace
    send('make a file\r')
    expect(r'● Write made\.txt[\s\S]*Allow\? .*v view all › $'); send('v\r')
    expect(r'\+ line12\n\s+Allow\? '); send('y\r')
    expect(r'Made it\.[\s\S]*SIBA hosted · mock/upstream-model[\s\S]*› $')
    assert open(os.path.join(cwd, 'made.txt')).read().count('\n') == 11
    send('/login\r')
    expect(r'Choose 1, 2 or 3 \[1\]: '); send('3\r')
    expect(r'Endpoint address: '); send(hosted + '\r')
    expect(r'Model: '); send('siba-code\r')
    expect(r'API key \[Enter for none\]: '); send('sk_siba_PTY_SECRET_1\r')
    expect(r'Now using SIBA hosted · siba-code\.[\s\S]*› $')
    assert b'PTY_SECRET' not in raw, 'a typed key is not echoed by a real terminal either'
    send('slow please\r'); expect(r'Slow part 1'); send('\x03')            # Ctrl+C arrives as a key (raw mode) and cancels the reply
    expect(r'Cancelled\.[\s\S]*› $')
    assert 'Slow part 4' not in text()
    send('typed words'); time.sleep(0.2); send('\x03'); time.sleep(0.2)    # empties the line
    send('\x03'); expect(r'Press Ctrl\+C again to leave\.'); send('\x03')
    expect(r'Goodbye\.')
    code = os.waitpid(pid, 0)[1]
    assert code == 0, 'exit status %r' % code
    print('pty ok')
finally:
    mock.kill()
