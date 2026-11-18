'use strict';
// The network side of sibac: the OpenAI-compatible chat client (streamed, with tool calls) and the fetch_url tool.
const dns = require('dns').promises, net = require('net'), http = require('http'), https = require('https');

// SIBAC_HOSTED points the hosted line somewhere else: a staging copy, or the mock server of the end-to-end test.
const HOSTED = process.env.SIBAC_HOSTED || 'https://siba.az/api/code/v1', GROQ = 'https://api.groq.com/openai/v1';
const NOSTREAM = new Set();   // endpoints that answered only after streaming was switched off (this run only)

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
});

// Puts a streamed reply (server-sent events in OpenAI delta format) back together: text, reasoning, tool calls, model name, token usage.
// A network read can end anywhere, in the middle of a line or of a character: bytes are decoded as a stream and only whole lines are parsed.
function sse(onText) {
  const m = { content: '', reasoning: '', calls: [] }, meta = {}, dec = new TextDecoder();
  let buf = '';
  const data = (line) => {
    if (!line.startsWith('data:')) return;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') return;
    const j = JSON.parse(d);
    if (j.error) throw new Error(`${j.error.code || ''} ${j.error.message || j.error}`.trim());
    if (j.model) meta.model = j.model;
    if (j.usage || j.x_groq?.usage) meta.usage = j.usage || j.x_groq.usage;
    const delta = j.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) { m.content += delta.content; onText?.(delta.content); }
    m.reasoning += delta.reasoning || delta.reasoning_content || '';
    for (const c of delta.tool_calls || []) {
      // a call arrives in pieces that share an index; servers that send no index start a new call with each id
      const t = (m.calls[c.index ?? (c.id ? m.calls.length : m.calls.length - 1)] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (c.id) t.id = c.id;
      if (c.function?.name) t.function.name = c.function.name;
      t.function.arguments += c.function?.arguments || '';
    }
  };
  return {
    feed(chunk) {
      buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) data(buf.slice(0, i).replace(/\r$/, ''));
    },
    done() {
      buf += dec.decode();
      if (buf) data(buf);
      const calls = m.calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || 'call_' + i }));
      return { message: { content: m.content, ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, ...meta };
    },
  };
}

// The server's own words from an error body: { error: { message } } or { error: "..." }, else the raw text (tags removed).
const said = (text) => {
  let j;
  try { j = JSON.parse(text); } catch {}
  return String((j && (typeof j.error === 'string' ? j.error : j.error?.message || j.message)) || text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
};
// A failed request as a sentence with what to do next. wait: the retry-after seconds of a 429.
function explain(status, text, conf, url, wait) {
  const m = said(text).slice(0, 300).replace(/([^.!?])$/, '$1.'), it = m ? ` It said: ${m}` : '', hosted = conf.baseUrl === HOSTED;
  if (status === 429 && wait > 90) return `${m || 'The limit for today is reached.'} It opens again in about ${wait > 5400 ? Math.round(wait / 3600) + ' hours' : Math.ceil(wait / 60) + ' minutes'}. To go on now, use your own key: /login.`;
  if (status === 429) return `${m || 'The line is busy right now.'} Wait a minute and send it again${hosted ? ', or use your own key: /login.' : '.'}`;
  if (status === 413) return `This request is too large for ${hosted ? 'the free hosted line' : 'the endpoint'}.${it} /compact shrinks the conversation; attach smaller files${hosted ? '; or use your own key: /login' : ''}.`;
  if (status === 401) return `The key was not accepted (401).${it} /login enters another one${hosted ? ', /logout goes on without a key' : ''}.`;
  if (status === 403) return `The endpoint refused the request (403).${it} If it needs a key, enter it with /login.`;
  if (status === 404) return `Nothing answers at ${url} (404).${it} Check the endpoint with /login and the model name with /model.`;
  if (status === 503 && conf.model === 'siba-oak') return 'SIBA Oak is offline right now (it runs on a small server that is not always on). Switch back with /model siba-code.';
  if (status >= 500) return `The model service has a problem (${status}).${it} Try again in a moment.`;
  return `The endpoint answered ${status}.${it}`;
}

// One model call. o: version, tools (omit for chat only), signal, onText(piece), onWait(seconds, why).
// Returns { message, model, usage }; model is the name the endpoint reports, which for the hosted line is the real upstream model.
async function chat(conf, messages, o = {}) {
  const url = conf.baseUrl.replace(/\/+$/, '') + '/chat/completions', host = new URL(url).host;
  const headers = { 'content-type': 'application/json', 'user-agent': 'sibac/' + o.version, 'x-sibac-version': String(o.version), ...(conf.apiKey ? { authorization: 'Bearer ' + conf.apiKey } : {}) };
  for (let tries = 0, stream = !NOSTREAM.has(url), fellBack = false; ; tries++) {
    const body = { model: conf.model, messages, ...(o.tools ? { tools: o.tools, tool_choice: 'auto' } : {}), temperature: 0.2, ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) };
    let r;
    try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal }); }
    catch (e) {
      if (o.signal?.aborted) throw e;
      throw new Error(`Could not reach ${host} (${e.cause?.code || e.message}). Check the internet connection and the endpoint address; "sibac doctor" tests both.`);
    }
    if (r.ok && /event-stream/i.test(r.headers.get('content-type') || '')) {
      const a = sse(o.onText);
      try { for await (const chunk of r.body) a.feed(chunk); }
      catch (e) {
        if (o.signal?.aborted) throw e;
        if (/tool_use_failed/.test(e.message) && tries < 2) continue;   // the model wrote a malformed tool call: ask again
        throw new Error(`The reply stopped half-way (${e.message}). Send the message again.`);
      }
      return a.done();
    }
    const text = await r.text();
    const wait = Number(r.headers.get('retry-after')) || 0;
    if (r.status === 429 && tries < 3 && wait <= 90) {   // a longer wait is a daily cap: waiting it out is no use
      const s = Math.min(60, Math.ceil(wait || 5 * (tries + 1)));
      o.onWait?.(s, said(text));
      await sleep(s * 1000, o.signal);
      o.onWait?.(0);
      continue;
    }
    if (r.status === 400 && text.includes('tool_use_failed') && tries < 2) continue;
    if (stream && [400, 415, 422, 501].includes(r.status)) { stream = false; fellBack = true; continue; }   // perhaps it cannot stream: ask once more without
    if (!r.ok) throw Object.assign(new Error(explain(r.status, text, conf, url, wait)), { status: r.status });
    let j;
    try { j = JSON.parse(text); } catch {}
    const m = j?.choices?.[0]?.message;
    if (!m) throw new Error(`${host} answered, but not with a chat reply. Is ${conf.baseUrl} an OpenAI-compatible endpoint? /login changes it.`);
    if (fellBack) NOSTREAM.add(url);
    if (m.content) o.onText?.(m.content);
    return { message: m, model: j.model, usage: j.usage };
  }
}

// Loopback, private, link-local, carrier-NAT (Tailscale), multicast and other reserved ranges: never fetched.
function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase(), v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return v4 ? privateIp(v4[1]) : l === '::' || l === '::1' || /^(f[cdef]|fe[89ab]|::ffff:|64:ff9b:)/.test(l);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19));
}
// Checks an address for fetch_url. Returns the URL and the one IP address it may be reached at; every address the name resolves to must be public.
async function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error(`not a web address: ${raw}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https addresses are fetched');
  if (u.username || u.password) throw new Error('addresses with a user name or password are not fetched');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const found = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error(`no such host: ${host}`); });
  if (!found.length || found.some((f) => privateIp(f.address))) throw new Error(`${host} is a private, local or reserved address; only the public internet is fetched`);
  return { u, address: found[0].address };
}
// One GET, connected to the address that was checked and to no other: the name is not resolved a second time, so a DNS answer
// that changes after the check (rebinding) cannot send the request to a private address. The name stays in the URL, so the Host
// header and the TLS certificate check are those of the original host.
const open = (u, address, signal) => new Promise((ok, fail) => {
  const family = net.isIPv6(address) ? 6 : 4;
  (u.protocol === 'https:' ? https : http).request(u, {
    agent: false, signal, headers: { 'user-agent': 'sibac', accept: 'text/*, application/json' },
    lookup: (_, o, done) => (o.all ? done(null, [{ address, family }]) : done(null, address, family)),
  }).on('response', ok).on('error', fail).end();
});
// GET a public page as text: redirects are followed by hand (at most 5) and each target is checked and pinned the same way; at most 300 KB is read; 15 second limit.
// check is replaced in the tests only.
async function fetchText(raw, signal, check = publicUrl) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15000);
  signal?.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    for (let hop = 0, at = raw; hop <= 5; hop++) {
      const { u, address } = await check(at);
      const r = await open(u, address, ac.signal);
      const type = r.headers['content-type'] || '';
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.destroy(); at = new URL(r.headers.location, u).href; continue; }
      if (!/text|json|xml|javascript|yaml|csv/i.test(type)) { r.destroy(); throw new Error(`not text (${type || 'no content type'}); fetch_url reads text only`); }
      const parts = [];
      let size = 0;
      for await (const chunk of r) { parts.push(chunk); if ((size += chunk.length) > 300000) break; }
      r.destroy();
      let text = Buffer.concat(parts).toString('utf8').slice(0, 300000);
      if (/html/i.test(type)) text = text.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n');
      return `HTTP ${r.statusCode} ${type}\n\n${text.trim()}`;
    }
    throw new Error('too many redirects');
  } catch (e) {
    if (ac.signal.aborted && !signal?.aborted) throw new Error('no answer within 15 seconds');
    throw e;
  } finally { clearTimeout(timer); }
}

module.exports = { HOSTED, GROQ, sse, said, explain, chat, privateIp, publicUrl, open, fetchText };
