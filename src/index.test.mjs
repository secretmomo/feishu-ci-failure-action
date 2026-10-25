import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildNotification, logTail, readLogWindow, run } from './index.mjs';

const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/example-token';
const base = {
  INPUT_WEBHOOK: webhook,
  INPUT_STEPS: JSON.stringify({ install: { outcome: 'success' }, check: { outcome: 'failure' } }),
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'secret-momo/example',
  GITHUB_WORKFLOW: 'CI',
  GITHUB_JOB: 'check',
  GITHUB_RUN_ID: '123',
  GITHUB_REF_NAME: 'main',
  GITHUB_SHA: '1234567890abcdef',
  GITHUB_ACTOR: 'developer',
};

async function invoke(env = {}, options = {}) {
  const requests = [];
  const logs = [];
  const status = await run({
    env: { ...base, ...env },
    post: async (url, init) => {
      requests.push({ url, ...init, payload: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ code: 0 }) };
    },
    log: (message) => logs.push(message),
    ...options,
  });
  return { status, requests, logs };
}

test('sends a Feishu interactive card with workflow metadata and run link', async () => {
  const { status, requests } = await invoke();
  assert.equal(status, 'sent');
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, webhook);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.payload.msg_type, 'interactive');
  assert.equal(request.payload.card.schema, '2.0');
  assert.match(request.payload.card.body.elements[0].content, /secret-momo\/example/);
  assert.match(request.payload.card.body.elements[0].content, /1234567890ab/);
  assert.equal(request.payload.card.body.elements[2].behaviors[0].default_url,
    'https://github.com/secret-momo/example/actions/runs/123');
});

for (const outcome of ['success', 'skipped', 'cancelled']) {
  test(`ignores install failure when check is ${outcome}`, async () => {
    const result = await invoke({ INPUT_STEPS: JSON.stringify({ install: { outcome: 'failure' }, check: { outcome } }) });
    assert.equal(result.status, 'skipped');
    assert.equal(result.requests.length, 0);
  });
}

test('uses outcome rather than conclusion for continue-on-error checks', async () => {
  const result = await invoke({ INPUT_STEPS: '{"check":{"outcome":"failure","conclusion":"success"}}' });
  assert.equal(result.status, 'sent');
});

test('supports custom check ID and a relative workspace log path', async () => {
  const paths = [];
  const result = await invoke({
    INPUT_STEPS: '{"test":{"outcome":"failure"}}',
    'INPUT_CHECK-STEP': 'test',
    'INPUT_LOG-FILE': 'logs/test.log',
    GITHUB_WORKSPACE: tmpdir(),
  }, { read: async (path) => { paths.push(path); return 'test failure'; } });
  assert.equal(result.status, 'sent');
  assert.deepEqual(paths, [resolve(tmpdir(), 'logs/test.log')]);
  assert.match(result.requests[0].body, /test failure/);
});

test('does not read logs for a skipped check', async () => {
  await invoke({ INPUT_STEPS: '{"check":{"outcome":"skipped"}}', 'INPUT_LOG-FILE': 'check.log' }, {
    read: () => assert.fail('must not read logs'),
  });
});

test('missing webhook skips even with malformed steps', async () => {
  const result = await invoke({ INPUT_WEBHOOK: '', INPUT_STEPS: 'invalid' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.requests.length, 0);
});

for (const steps of ['not-json-secret', 'null', '[]', '42', '{}', '{"toString":{"outcome":"failure"}}']) {
  test(`invalid or missing target steps produces a warning: ${steps}`, async () => {
    const result = await invoke({ INPUT_STEPS: steps });
    assert.equal(result.status, 'warning');
    assert.equal(result.requests.length, 0);
    assert.ok(result.logs.some((line) => line.startsWith('::warning::')));
    assert.ok(!result.logs.join('\n').includes('not-json-secret'));
  });
}

test('missing, empty, and unreadable logs still produce useful notifications', async () => {
  for (const read of [async () => '', async () => { throw new Error('ENOENT'); }]) {
    const result = await invoke({ 'INPUT_LOG-FILE': 'missing.log' }, { read });
    assert.equal(result.status, 'sent');
    assert.match(result.requests[0].body, /请查看 CI 运行详情/);
  }
});

test('redacts webhook and overlapping explicit secrets before trimming logs', async () => {
  const secret = 'password-long-value';
  const result = await invoke({ 'INPUT_LOG-FILE': 'check.log', 'INPUT_REDACT-VALUES': `password\n${secret}\na"b` }, {
    read: async () => `\u001b[31m${webhook}\u001b[0m\n${secret}\na"b\n${'x'.repeat(2795)}`,
  });
  const body = result.requests[0].body;
  assert.ok(!body.includes(webhook));
  assert.ok(!body.includes('password'));
  assert.ok(!body.includes('long-value'));
  assert.ok(!body.includes('a\\"b'));
  assert.ok(!body.includes('\\u001b'));
});

test('removes ANSI sequences, including OSC hyperlinks, and masks split secrets', async () => {
  const reason = await logTail('log', ['token-value'], async () =>
    '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007 token-\u001b[31mvalue\u001b[0m');
  assert.equal(reason, 'link [已隐藏]');
});

test('limits output to the last 25 lines and 2800 characters', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const reason = await logTail('log', [], async () => lines);
  assert.equal(reason.split('\n').length, 25);
  assert.ok(reason.startsWith('line 25'));
  const long = await logTail('log', [], async () => 'x'.repeat(5000));
  assert.equal(long.length, 2800);
});

test('log backticks cannot close the generated code fence', () => {
  const reason = 'error\n````\nmore';
  const card = buildNotification(base, 'check', reason);
  assert.ok(card.body.elements[1].content.includes(`\n\n\`\`\`\`\`\n${reason}\n\`\`\`\`\``));
});

test('escapes branch mentions and Markdown and redacts metadata', async () => {
  const result = await invoke({
    GITHUB_HEAD_REF: '<at id=all></at>**branch**',
    GITHUB_WORKFLOW: 'secret"value',
    'INPUT_REDACT-VALUES': 'secret"value',
  });
  const details = result.requests[0].payload.card.body.elements[0].content;
  assert.ok(!details.includes('<at'));
  assert.ok(details.includes('&lt;at'));
  assert.ok(details.includes('\\*\\*branch\\*\\*'));
  assert.ok(!details.includes('secret"value'));
  assert.ok(details.includes('已隐藏'));
});

test('short redact values cannot corrupt the card JSON structure', async () => {
  const result = await invoke({ 'INPUT_REDACT-VALUES': 'a\n0' });
  assert.equal(result.status, 'sent');
  assert.equal(result.requests[0].payload.card.schema, '2.0');
  assert.equal(result.requests[0].payload.card.body.elements[0].tag, 'markdown');
});

for (const url of ['http://example.com', 'not-a-url', 'https://user:pass@example.com']) {
  test('invalid or insecure webhook only warns: ' + url, async () => {
    const result = await invoke({ INPUT_WEBHOOK: url });
    assert.equal(result.status, 'warning');
    assert.equal(result.requests.length, 0);
  });
}

for (const [name, post] of [
  ['network/timeout', async () => { throw new Error(`private network error ${webhook}`); }],
  ['HTTP', async () => ({ ok: false, status: 429 })],
  ['invalid JSON', async () => ({ ok: true, json: async () => { throw new Error('private body'); } })],
  ['business failure', async () => ({ ok: true, json: async () => ({ code: 19024, msg: 'private body' }) })],
  ['empty result', async () => ({ ok: true, json: async () => null })],
]) {
  test(`${name} failure warns without exposing the response or network error`, async () => {
    const result = await invoke({}, { post });
    assert.equal(result.status, 'warning');
    const warnings = result.logs.filter((line) => line.startsWith('::warning::')).join('\n');
    assert.ok(warnings);
    assert.ok(!warnings.includes(webhook));
    assert.ok(!warnings.includes('private'));
  });
}

test('mask commands escape CR and percent in explicit values', async () => {
  const result = await invoke({ 'INPUT_REDACT-VALUES': 'sensitive%\r::warning::injected' });
  assert.ok(result.logs.includes('::add-mask::sensitive%25%0D::warning::injected'));
});

test('reads real UTF-8 logs and leaves .env untouched', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-action-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'check.log'), '检查失败：类型不匹配');
  await writeFile(join(dir, '.env'), 'TOKEN=never-read');
  const reads = [];
  const result = await invoke({ GITHUB_WORKSPACE: dir, 'INPUT_LOG-FILE': 'check.log' }, {
    read: async (...args) => { reads.push(args[0]); return readFile(...args); },
  });
  assert.equal(result.status, 'sent');
  assert.match(result.requests[0].body, /检查失败：类型不匹配/);
  assert.deepEqual(reads, [join(dir, 'check.log')]);
});

test('action entry point exits successfully on warning and skip', () => {
  for (const env of [{ INPUT_WEBHOOK: '', INPUT_STEPS: '' }, { INPUT_WEBHOOK: webhook, INPUT_STEPS: 'invalid' }]) {
    const child = spawnSync(process.execPath, ['src/index.mjs'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, GITHUB_OUTPUT: '', ...env },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    assert.match(child.stdout, /跳过|::warning::/);
  }
});

test('ignores whitespace-only redact lines and preserves spaces in real secrets', async () => {
  const result = await invoke({ 'INPUT_REDACT-VALUES': ' \n\t\n  padded-secret  ', 'INPUT_LOG-FILE': 'log' }, {
    read: async () => 'value=  padded-secret  !',
  });
  assert.deepEqual(result.logs.filter((line) => line.startsWith('::add-mask::')), [
    `::add-mask::${webhook}`, '::add-mask::  padded-secret  ',
  ]);
  assert.ok(!result.requests[0].body.includes('padded-secret'));
});

test('short secrets stay redacted in payload without becoming global masks', async () => {
  const result = await invoke({ 'INPUT_REDACT-VALUES': 'xy\n e ', 'INPUT_LOG-FILE': 'log' }, {
    read: async () => 'value=xy and e end',
  });
  assert.equal(result.status, 'sent');
  assert.ok(!result.requests[0].body.includes('value=xy'));
  assert.ok(!result.requests[0].body.includes('and e end'));
  assert.deepEqual(result.logs.filter((line) => line.startsWith('::add-mask::')), [`::add-mask::${webhook}`]);
  assert.equal(result.logs.filter((line) => line.startsWith('::warning::')).length, 1);
});

test('blank check-step falls back to check', async () => {
  assert.equal((await invoke({ 'INPUT_CHECK-STEP': ' \t ' })).status, 'sent');
});

test('direct outcome works without steps and takes priority over malformed steps', async () => {
  for (const steps of ['', 'invalid', 'x'.repeat(200000)]) {
    const result = await invoke({ INPUT_OUTCOME: ' failure ', INPUT_STEPS: steps });
    assert.equal(result.status, 'sent');
  }
});

test('blank direct outcome falls back to steps', async () => {
  assert.equal((await invoke({ INPUT_OUTCOME: ' ' })).status, 'sent');
});

test('missing or invalid outcome warns without sending', async () => {
  for (const env of [
    { INPUT_STEPS: '' },
    { INPUT_STEPS: '{"other":{"outcome":"failure"}}' },
    { INPUT_STEPS: '{"check":{}}' },
    { INPUT_OUTCOME: 'failed' },
  ]) {
    const result = await invoke(env);
    assert.equal(result.status, 'warning');
    assert.equal(result.requests.length, 0);
  }
});

for (const outcome of ['success', 'skipped', 'cancelled']) {
  test(`direct ${outcome} outcome skips without inspecting steps or logs`, async () => {
    const result = await invoke({ INPUT_OUTCOME: outcome, INPUT_STEPS: 'invalid', 'INPUT_LOG-FILE': 'log' }, {
      read: () => assert.fail('must not read'),
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.requests.length, 0);
  });
}

test('log truncation keeps valid surrogate pairs and drops partial first lines', async () => {
  const reason = await logTail('log', [], async () => 'x'.repeat(10) + '😀' + 'y'.repeat(2799));
  assert.equal(reason, 'y'.repeat(2799));
  const multiline = await logTail('log', [], async () => 'x'.repeat(4000) + '\n完整行');
  assert.equal(multiline, '完整行');
  const exactLine = await logTail('log', [], async () => 'prefix\n' + 'y'.repeat(2797) + '\nx');
  assert.equal(exactLine, 'y'.repeat(2797) + '\nx');
});

test('reads a 64 KiB window plus one context byte from a 5 MiB log and closes the file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-large-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'large.log');
  await writeFile(path, 'x'.repeat(5 * 1024 * 1024) + '\nlast error 😀');
  let bytesRead = 0;
  let closed = false;
  const text = await readLogWindow(path, 'utf8', async (...args) => {
    const handle = await open(...args);
    return {
      stat: () => handle.stat(),
      read: async (...readArgs) => { const result = await handle.read(...readArgs); bytesRead += result.bytesRead; return result; },
      close: async () => { closed = true; await handle.close(); },
    };
  });
  assert.equal(text, 'last error 😀');
  assert.ok(bytesRead <= 65537);
  assert.equal(closed, true);
  const result = await invoke({ 'INPUT_LOG-FILE': path });
  assert.equal(result.status, 'sent');
  assert.match(result.requests[0].body, /last error 😀/);
  assert.ok(!result.requests[0].body.includes('xxxxx'));
});

test('oversized single-line logs expand safely without exposing partial secrets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  const secret = 'SECRET' + 'x'.repeat(70000);
  await writeFile(path, secret);
  const reason = await logTail(path, [secret]);
  assert.equal(reason, '[已隐藏]');
  await writeFile(path, secret + '\nsafe error');
  assert.equal(await logTail(path, [secret]), 'safe error');
  await writeFile(path, secret + 'z'.repeat(1024 * 1024));
  assert.match(await logTail(path, [secret]), /单行超过读取上限/);
});

test('preserves a plain 65 KiB single-line log by reading only the expanded prefix', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-oneline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  await writeFile(path, 'B'.repeat(65 * 1024));
  let bytesRead = 0;
  let closed = false;
  const reason = await logTail(path, [], (file, encoding) => readLogWindow(file, encoding, async (...args) => {
    const handle = await open(...args);
    return {
      stat: () => handle.stat(),
      read: async (...readArgs) => { const result = await handle.read(...readArgs); bytesRead += result.bytesRead; return result; },
      close: async () => { closed = true; await handle.close(); },
    };
  }));
  assert.equal(reason, 'B'.repeat(2800));
  assert.equal(bytesRead, 65 * 1024);
  assert.equal(closed, true);
  await writeFile(path, 'B'.repeat(65 * 1024) + '\n');
  assert.equal(await logTail(path, []), 'B'.repeat(2800));
});

test('expansion caps total reads at 1 MiB and gives a distinct safe diagnostic', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  await writeFile(path, 'sensitive-fragment'.repeat(130000));
  let bytesRead = 0;
  let closed = false;
  const reason = await logTail(path, [], (file, encoding) => readLogWindow(file, encoding, async (...args) => {
    const handle = await open(...args);
    return {
      stat: () => handle.stat(),
      read: async (...readArgs) => { const result = await handle.read(...readArgs); bytesRead += result.bytesRead; return result; },
      close: async () => { closed = true; await handle.close(); },
    };
  }));
  assert.equal(bytesRead, 1024 * 1024);
  assert.equal(closed, true);
  assert.match(reason, /单行超过读取上限/);
  assert.ok(!reason.includes('sensitive-fragment'));
  assert.ok(!reason.includes('未提供可用'));
});

test('skip paths do not warn about short redact values', async () => {
  for (const env of [
    { INPUT_WEBHOOK: '' },
    { INPUT_OUTCOME: 'success' },
    { INPUT_OUTCOME: 'skipped' },
    { INPUT_OUTCOME: 'cancelled' },
  ]) {
    const result = await invoke({ ...env, 'INPUT_REDACT-VALUES': 'xy' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.requests.length, 0);
    assert.ok(!result.logs.some((line) => line.startsWith('::warning::')));
  }
});

test('normalizes CR/CRLF log lines and applies the 25-line limit', async () => {
  const reason = await logTail('log', [], async () =>
    Array.from({ length: 35 }, (_, i) => `progress ${i}`).join('\r') + '\r\nERROR boom');
  assert.equal(reason.split('\n').length, 25);
  assert.ok(reason.startsWith('progress 11\n'));
  assert.ok(reason.endsWith('\nERROR boom'));
  assert.ok(!reason.includes('\r'));
});

test('CR normalization preserves redaction of secrets containing literal CR and ANSI', async () => {
  const reason = await logTail('log', ['token\rsecret'], async () =>
    'first: token\rsecret\r\nsecond: token\r\u001b[31msecret\u001b[0m');
  assert.equal(reason, 'first: [已隐藏]\nsecond: [已隐藏]');
});

for (const [name, separator] of [
  ['NUL', '\0'], ['CR', '\r'], ['LF', '\n'], ['tab', '\t'],
  ['DEL', '\u007f'], ['C1', '\u0080'], ['ANSI', '\u001b[31m'],
  ['mixed controls', '\0\r\n\t\u001b[31m'],
]) {
  test(`request payload masks a secret split by ${name}`, async () => {
    const result = await invoke({ 'INPUT_LOG-FILE': 'log', 'INPUT_REDACT-VALUES': 'password' }, {
      read: async () => `context\npass${separator}word\nERROR safe`,
    });
    assert.equal(result.status, 'sent');
    const content = result.requests[0].payload.card.body.elements[1].content;
    assert.ok(content.includes('context\n[已隐藏]\nERROR safe'));
    assert.ok(!content.includes('pass'));
    assert.ok(!content.includes('word'));
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(content));
  });
}

test('control-separated matching preserves literal-CR secrets and handles long values', async () => {
  const result = await invoke({ 'INPUT_LOG-FILE': 'log', 'INPUT_REDACT-VALUES': 'token\rsecret' }, {
    read: async () => 'context\ntoken\rsec\0ret\nERROR safe',
  });
  const content = result.requests[0].payload.card.body.elements[1].content;
  assert.ok(content.includes('context\n[已隐藏]\nERROR safe'));
  assert.ok(!content.includes('secret'));
  const long = 'S'.repeat(70000);
  const reason = await logTail('log', [long], async () => 'context\n' + long.slice(0, 35000) + '\0' + long.slice(35000) + '\nERROR safe');
  assert.equal(reason, 'context\n[已隐藏]\nERROR safe');
});

test('control-separated secrets are redacted before the final log truncation', async () => {
  const reason = await logTail('log', ['password'], async () => 'pass\0word' + 'x'.repeat(2795));
  assert.ok(!reason.includes('pass'));
  assert.ok(!reason.includes('word'));
});

test('configured values are removed from title, fallback, labels, and button text', async () => {
  for (const secret of ['CI', '未提供可用', '失败', '查看']) {
    const result = await invoke({ 'INPUT_REDACT-VALUES': secret });
    assert.equal(result.status, 'sent');
    assert.ok(!result.requests[0].body.includes(secret));
    assert.equal(result.requests[0].payload.msg_type, 'interactive');
    assert.equal(result.requests[0].payload.card.schema, '2.0');
    assert.equal(result.requests[0].payload.card.body.elements[0].tag, 'markdown');
  }
  assert.ok(!(await logTail('', ['CI'])).includes('CI'));
});

test('final card redaction covers diagnostics while retaining protocol values', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-diagnostic-redact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  await writeFile(path, 'x'.repeat(1100000));
  const result = await invoke({ 'INPUT_LOG-FILE': path, 'INPUT_REDACT-VALUES': '读取上限\nmarkdown\ninteractive' });
  assert.equal(result.status, 'sent');
  const card = result.requests[0].payload.card;
  assert.ok(!card.body.elements[1].content.includes('读取上限'));
  assert.ok(card.body.elements[1].content.includes('[已隐藏]'));
  assert.equal(card.body.elements[1].tag, 'markdown');
  assert.equal(result.requests[0].payload.msg_type, 'interactive');
});

test('FIFO logs and FIFO symlinks without writers never block notification', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-fifo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pipe = join(dir, 'pipe');
  const link = join(dir, 'pipe-link');
  const created = spawnSync('mkfifo', [pipe], { timeout: 5000 });
  assert.equal(created.status, 0, created.stderr?.toString());
  await symlink(pipe, link);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { logTail, run } = await import(process.env.ACTION_MODULE_URL);
    const reasons = [];
    for (const path of JSON.parse(process.env.FIFO_PATHS)) reasons.push(await logTail(path, []));
    const status = await run({
      env: { INPUT_WEBHOOK: 'https://ci.invalid/hook', INPUT_OUTCOME: 'failure', 'INPUT_LOG-FILE': JSON.parse(process.env.FIFO_PATHS)[0] },
      post: async () => ({ ok: true, json: async () => ({ code: 0 }) }), log: () => {},
    });
    console.log(JSON.stringify({ reasons, status }));
  `], {
    env: { ...process.env, ACTION_MODULE_URL: new URL('./index.mjs', import.meta.url).href, FIFO_PATHS: JSON.stringify([pipe, link]) },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'sent');
  for (const reason of result.reasons) assert.match(reason, /未提供可用的检查日志/);
});

test('blank log tails respect the read budget and distinguish blank content from long lines', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-blank-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  await writeFile(path, 'ERROR earlier\n' + '\n'.repeat(70000));
  assert.equal(await logTail(path, []), 'ERROR earlier');
  await writeFile(path, 'ERROR beyond budget\n' + '\n'.repeat(1100000));
  let bytesRead = 0;
  const reason = await logTail(path, [], (file, encoding) => readLogWindow(file, encoding, async (...args) => {
    const handle = await open(...args);
    return {
      stat: () => handle.stat(),
      read: async (...readArgs) => { const result = await handle.read(...readArgs); bytesRead += result.bytesRead; return result; },
      close: () => handle.close(),
    };
  }));
  assert.equal(bytesRead, 1024 * 1024);
  assert.match(reason, /仅有空白/);
  assert.match(reason, /停止回溯/);
  assert.ok(!reason.includes('单行超过'));
  assert.ok(!reason.includes('ERROR beyond budget'));
});

test('large CR-only and CRLF logs retain their error tail with bounded reads and redaction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-cr-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  for (const ending of ['\r', '\r\n']) {
    await writeFile(path, ('progress' + ending).repeat(140000) + 'ERROR token-value');
    let bytesRead = 0;
    const text = await readLogWindow(path, 'utf8', async (...args) => {
      const handle = await open(...args);
      return {
        stat: () => handle.stat(),
        read: async (...readArgs) => { const result = await handle.read(...readArgs); bytesRead += result.bytesRead; return result; },
        close: () => handle.close(),
      };
    });
    assert.ok(bytesRead <= 65537);
    assert.ok(!text.startsWith('\n'));
    const reason = await logTail(path, ['token-value']);
    assert.ok(reason.endsWith('ERROR [已隐藏]'));
    assert.equal(reason.split('\n').length, 25);
    assert.ok(!reason.includes('\r'));
    assert.ok(!reason.includes('token-value'));
  }
});

test('CR read boundaries never split configured secrets containing literal CR', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-cr-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  const secret = 'PREFIX\rprivate-suffix';
  await writeFile(path, 'x'.repeat(1100000) + secret);
  const reason = await logTail(path, [secret]);
  assert.match(reason, /未找到可安全展示/);
  assert.ok(!reason.includes('private-suffix'));
  await writeFile(path, 'x'.repeat(1100000) + secret + '\nsafe error');
  assert.equal(await logTail(path, [secret]), 'safe error');
});

test('aligned read windows preserve the complete first error record after LF, CR, and CRLF', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-aligned-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  for (const ending of ['\n', '\r', '\r\n']) {
    const record = `ERROR earlier${ending}status`;
    const tail = record + ' '.repeat(65536 - Buffer.byteLength(record));
    await writeFile(path, 'prefix' + ending + tail);
    assert.equal(await readLogWindow(path), tail);
    assert.equal(await logTail(path, []), 'ERROR earlier\nstatus');
  }
});

test('mid-record windows still drop incomplete secrets for LF, CR, and CRLF', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-mid-record-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  for (const ending of ['\n', '\r', '\r\n']) {
    const record = `private-suffix${ending}ERROR safe 😀`;
    const tail = record + ' '.repeat(65536 - Buffer.byteLength(record));
    await writeFile(path, 'prefix:SECRET-' + tail);
    assert.equal(await logTail(path, ['SECRET-private-suffix']), 'ERROR safe 😀');
  }
  const suffix = Buffer.concat([Buffer.from('😀').subarray(1), Buffer.from('\nERROR UTF8 safe')]);
  const tail = Buffer.concat([suffix, Buffer.alloc(65536 - suffix.length, 32)]);
  await writeFile(path, Buffer.concat([Buffer.from('prefix'), Buffer.from('😀').subarray(0, 1), tail]));
  assert.equal(await logTail(path, []), 'ERROR UTF8 safe');
});

test('a CRLF spanning context and content is consumed as one separator', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-split-crlf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  const record = '\nERROR earlier\nstatus';
  const tail = record + ' '.repeat(65536 - Buffer.byteLength(record));
  await writeFile(path, 'prefix\r' + tail);
  assert.equal(await readLogWindow(path), tail.slice(1));
  assert.equal(await logTail(path, []), 'ERROR earlier\nstatus');
});

test('expanded read windows also preserve a first record aligned to the boundary', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-expanded-aligned-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'log');
  const record = 'ERROR expanded\n';
  const expandedContentBytes = 2 * (65536 + 1) - 1;
  const tail = record + 'Q'.repeat(expandedContentBytes - Buffer.byteLength(record));
  await writeFile(path, 'prefix\n' + tail);
  assert.equal(await readLogWindow(path), tail);
});

test('card includes Runner OS/architecture and a fallback when absent', () => {
  const details = buildNotification({ ...base, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' }, 'check', 'error').body.elements[0].content;
  assert.match(details, /Runner：\*\* Linux \/ X64/);
  assert.match(buildNotification(base, 'check', 'error').body.elements[0].content, /Runner：\*\* 未知/);
});

test('unsupported response shapes do not count as successful v2 notifications', async () => {
  for (const result of [{ code: '0' }, { StatusCode: 0 }, { code: 1, StatusCode: 0 }]) {
    assert.equal((await invoke({}, { post: async () => ({ ok: true, json: async () => result }) })).status, 'warning');
  }
});

test('unexpected program errors use generic warnings and safe debug classification', async () => {
  const result = await invoke({}, { post: async () => ({
    get ok() { throw new TypeError('private data not to echo'); },
  }) });
  assert.equal(result.status, 'warning');
  assert.ok(result.logs.some((line) => line.startsWith('::warning::') && line.includes('内部异常')));
  assert.ok(result.logs.some((line) => line.startsWith('::debug::') && line.includes('TypeError')));
  assert.ok(!result.logs.join('\n').includes('private data'));
});

test('symlink entry executes instead of silently doing nothing', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'entry.mjs');
  await symlink(resolve(import.meta.dirname, 'index.mjs'), entry);
  const child = spawnSync(process.execPath, [entry], {
    env: { ...process.env, INPUT_WEBHOOK: '', GITHUB_OUTPUT: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /跳过飞书通知/);
});

test('metadata-driven action entry validates wiring and successful payload with mocked fetch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-wiring-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const metadata = await readFile(resolve(import.meta.dirname, '../action.yml'), 'utf8');
  const main = metadata.match(/^  main: (.+)$/m)?.[1];
  assert.equal(main, 'src/index.mjs');
  assert.match(metadata, /using: node24/);
  for (const input of ['outcome', 'steps', 'check-step', 'log-file', 'redact-values']) {
    assert.ok(metadata.includes(`  ${input}:\n`));
  }
  const logFile = join(dir, 'log');
  const outputFile = join(dir, 'output');
  await writeFile(logFile, 'smoke failure: private-smoke-token');
  const child = spawnSync(process.execPath, [main], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, INPUT_WEBHOOK: 'https://ci.invalid/hook', INPUT_OUTCOME: 'failure', INPUT_STEPS: 'invalid',
      'INPUT_CHECK-STEP': 'smoke-check', 'INPUT_LOG-FILE': logFile, 'INPUT_REDACT-VALUES': 'private-smoke-token',
      GITHUB_OUTPUT: outputFile,
      NODE_OPTIONS: '--import=./.github/scripts/mock-feishu.mjs',
    },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.match(child.stdout, /通知已发送/);
  assert.equal(await readFile(outputFile, 'utf8'), 'status=sent\n');
});
