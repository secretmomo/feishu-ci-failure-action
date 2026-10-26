import { constants, realpathSync } from 'node:fs';
import { appendFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, stripVTControlCharacters } from 'node:util';

const FALLBACK_REASON = '未提供可用的检查日志，请查看 CI 运行详情。';
const LOG_WINDOW_BYTES = 64 * 1024;
const LOG_WINDOW_MAX_BYTES = 1024 * 1024;
const ENV_FILE_MAX_BYTES = 1024 * 1024;

class DiagnosticError extends Error {}

export async function readEnvFile(path, _encoding = 'utf8', openFile = open) {
  const file = await openFile(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > ENV_FILE_MAX_BYTES) throw new Error();
    // One extra byte detects growth without allowing an unbounded readFile.
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size) throw new Error();
    return bytes.subarray(0, total).toString('utf8');
  } finally {
    await file.close();
  }
}

export async function readLogWindow(path, _encoding = 'utf8', openFile = open, allowCR = true, secrets = []) {
  // Opening first avoids a stat/open race. O_NONBLOCK prevents a FIFO without
  // a writer from hanging before fstat can reject it; Windows may omit the flag.
  const file = await openFile(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return '';
    // Include one leading context byte in the I/O budget, alongside the log window.
    let size = Math.min(stat.size, LOG_WINDOW_BYTES + 1);
    let start = stat.size;
    let bytes = Buffer.alloc(0);
    const prepared = stat.size > size ? prepareWindowSecrets(secrets) : [];
    for (;;) {
      const nextStart = stat.size - size;
      // Only read the new prefix when expanding, keeping total I/O <= 1 MiB.
      const prefix = Buffer.alloc(start - nextStart);
      let total = 0;
      while (total < prefix.length) {
        const { bytesRead } = await file.read(prefix, total, prefix.length - total, nextStart + total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total !== prefix.length) return ''; // File was truncated during reading.
      bytes = Buffer.concat([prefix, bytes]);
      start = nextStart;
      if (start === 0) return bytes.toString('utf8');
      // The first byte is context, not log content. A preceding separator proves
      // the first record is complete; otherwise discard only the partial record.
      const context = bytes[0];
      const window = bytes.subarray(1);
      const atLineStart = context === 10 || (allowCR && context === 13);
      const lf = window.indexOf(10);
      const cr = allowCR ? window.indexOf(13) : -1;
      const newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      if (atLineStart || newline >= 0) {
        const after = atLineStart
          ? (context === 13 && window[0] === 10 ? 1 : 0)
          : newline + (window[newline] === 13 && window[newline + 1] === 10 ? 2 : 1);
        let completeLines = window.subarray(after).toString('utf8');
        if (prepared.length) completeLines = sanitizeWindowStart(completeLines, prepared);
        if (completeLines.trim()) return completeLines;
      }
      if (size >= LOG_WINDOW_MAX_BYTES) {
        if (!bytes.toString('utf8').trim()) {
          throw new DiagnosticError('日志末尾 1 MiB 读取范围内仅有空白，已停止回溯更早的内容。请查看 CI 运行详情。');
        }
        if (newline >= 0 || bytes.includes(13)) {
          throw new DiagnosticError('日志读取达到 1 MiB 上限，未找到可安全展示的完整非空行。请查看 CI 运行详情。');
        }
        throw new DiagnosticError('日志末尾的单行超过读取上限（1 MiB），已安全省略日志。请查看 CI 运行详情。');
      }
      size = Math.min(stat.size, LOG_WINDOW_MAX_BYTES, size * 2);
    }
  } finally {
    await file.close();
  }
}

// GitHub workflow commands must escape line breaks, including in secret values.
function commandData(value) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function secretValues(webhook, extra, fileValues = []) {
  return [...new Set([webhook, ...extra.split(/\r?\n/), ...fileValues].filter((value) => value.trim()))]
    .sort((a, b) => b.length - a.length);
}

export function redact(text, secrets) {
  for (const secret of secrets) text = text.replaceAll(secret, '[已隐藏]');
  return text;
}

function prefixFailure(pattern) {
  const failure = new Uint32Array(pattern.length);
  for (let i = 1, matched = 0; i < pattern.length; i++) {
    while (matched && pattern[i] !== pattern[matched]) matched = failure[matched - 1];
    if (pattern[i] === pattern[matched]) matched++;
    failure[i] = matched;
  }
  return failure;
}

function redactControlSeparated(text, secrets, { leadingEnd = 0, allMatches = false } = {}) {
  const controls = /[\u0000-\u001f\u007f-\u009f]/g;
  const compact = text.replace(controls, '');
  if (compact === text && !allMatches && !leadingEnd) return text;
  let ends;
  if (leadingEnd) {
    ends = new Uint32Array(compact.length);
    ends[0] = leadingEnd;
  }
  for (const secret of secrets) {
    const needle = secret.replace(controls, '');
    if (!needle) continue;
    let start = compact.indexOf(needle);
    if (start < 0) continue;
    ends ??= new Uint32Array(compact.length);
    if (allMatches) {
      // Find every overlapping occurrence in linear time, including periodic
      // values. Repeated indexOf(..., start + 1) re-compares whole long needles.
      const failure = prefixFailure(needle);
      for (let i = start, matched = 0; i < compact.length; i++) {
        while (matched && compact[i] !== needle[matched]) matched = failure[matched - 1];
        if (compact[i] === needle[matched]) matched++;
        if (matched === needle.length) {
          const at = i + 1 - needle.length;
          ends[at] = Math.max(ends[at], i + 1);
          matched = failure[matched - 1];
        }
      }
      continue;
    }
    while (start >= 0) {
      ends[start] = Math.max(ends[start], start + needle.length);
      start = compact.indexOf(needle, start + needle.length);
    }
  }
  if (!ends) return text;
  // Map compact matches back to the original text, keeping ordinary line breaks
  // outside matched spans. Typed arrays avoid per-match objects or huge regexes.
  const offsets = new Uint32Array(compact.length);
  for (let i = 0, j = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 31 && (code < 127 || code > 159)) offsets[j++] = i;
  }
  const parts = [];
  let cursor = 0;
  for (let start = 0; start < ends.length;) {
    if (!ends[start]) { start++; continue; }
    let end = ends[start];
    for (let i = start + 1; i < end; i++) end = Math.max(end, ends[i]);
    parts.push(text.slice(cursor, offsets[start]), '[已隐藏]');
    cursor = offsets[end - 1] + 1;
    start = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function normalizeControls(text) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\r\n?/g, '\n');
}

function sanitizeText(text, secrets) {
  // Preserve exact matches, including secrets containing literal CR, before
  // changing their representation. Then handle control-separated matches.
  let cleaned = redact(text, secrets);
  cleaned = redact(stripVTControlCharacters(cleaned), secrets);
  cleaned = redactControlSeparated(cleaned, secrets);
  return redact(normalizeControls(cleaned), secrets);
}

function prepareWindowSecrets(secrets) {
  const controls = /[\u0000-\u001f\u007f-\u009f]/g;
  // Normalize each value once per read, retaining LF-aligned suffix offsets in
  // compact coordinates. Expansion reuses this data instead of slicing values.
  return secrets.map((secret) => {
    const cleaned = stripVTControlCharacters(secret);
    const lineStarts = new Set();
    let offset = 0;
    for (let i = 0; i < cleaned.length; i++) {
      const code = cleaned.charCodeAt(i);
      if (code === 10) lineStarts.add(offset);
      if (code > 31 && (code < 127 || code > 159)) offset++;
    }
    return { compact: cleaned.replace(controls, ''), lineStarts };
  });
}

function sanitizeWindowStart(text, prepared) {
  // All matching happens before replacement so overlapping complete values
  // cannot destroy a suffix match or be cut by hiding a shorter suffix first.
  const cleaned = stripVTControlCharacters(text);
  const compact = cleaned.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  // KMP: build the window prefix failure table once, then scan each compact
  // value once. At its end, follow borders to the longest LF-aligned suffix.
  const failure = prefixFailure(compact);
  let leadingEnd = 0;
  for (const { compact: secret, lineStarts } of prepared) {
    if (!compact.length || !lineStarts.size) continue;
    let matched = 0;
    for (let i = 0; i < secret.length; i++) {
      while (matched && (matched === compact.length || secret[i] !== compact[matched])) matched = failure[matched - 1];
      if (secret[i] === compact[matched]) matched++;
    }
    while (matched && !lineStarts.has(secret.length - matched)) matched = failure[matched - 1];
    leadingEnd = Math.max(leadingEnd, matched);
  }
  // Reuse the existing span merger and compact-to-text mapping. Include all
  // full matches in the same union, even when they extend beyond the suffix.
  return normalizeControls(redactControlSeparated(cleaned, prepared.map((value) => value.compact), { leadingEnd, allMatches: true }));
}

function redactCardText(value, secrets) {
  if (Array.isArray(value)) return value.map((item) => redactCardText(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'content' && typeof item === 'string' ? sanitizeText(item, secrets)
      : key === 'default_url' && typeof item === 'string' ? redact(item, secrets)
        : redactCardText(item, secrets),
  ]));
}

// Metadata can contain user-controlled branch names. Keep it literal in Markdown.
function markdownText(value) {
  return String(value || '未知')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_\[\]()~]/g, '\\$&').replace(/[\r\n]/g, ' ');
}

export async function logTail(path, secrets, read = readLogWindow) {
  if (!path) return sanitizeText(FALLBACK_REASON, secrets);
  try {
    // Redact before truncating so a secret straddling the cutoff cannot leak.
    // CR and multiline secrets require LF boundaries; guard the leading records
    // against multiline secrets beginning before the bounded read window.
    const raw = read === readLogWindow
      ? await readLogWindow(path, 'utf8', open, !secrets.some((value) => /[\r\n]/.test(value)),
        secrets.some((value) => value.includes('\n')) ? secrets : [])
      : await read(path, 'utf8');
    const log = sanitizeText(raw, secrets);
    let tail = log.trim().split(/\r?\n/).slice(-25).join('\n');
    if (tail.length > 2800) {
      const start = tail.length - 2800;
      const atLineStart = tail[start - 1] === '\n';
      tail = tail.slice(start);
      const newline = tail.indexOf('\n');
      if (!atLineStart && newline >= 0) tail = tail.slice(newline + 1);
      const first = tail.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
    }
    return tail || sanitizeText(FALLBACK_REASON, secrets);
  } catch (error) {
    return sanitizeText(error instanceof DiagnosticError ? error.message : FALLBACK_REASON, secrets);
  }
}

export function buildNotification(env, checkStep, reason, secrets = []) {
  const ticks = (reason.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, ticks + 1));
  const runUrl = redact(`${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, secrets);
  const details = [
    ['仓库', env.GITHUB_REPOSITORY],
    ['工作流', env.GITHUB_WORKFLOW],
    ['Job', env.GITHUB_JOB],
    ['Runner', [env.RUNNER_OS, env.RUNNER_ARCH].filter(Boolean).join(' / ')],
    ['失败步骤', checkStep],
    ['分支 / 引用', env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || env.GITHUB_REF],
    ['提交', env.GITHUB_SHA?.slice(0, 12)],
    ['触发者', env.GITHUB_ACTOR],
    ['运行次数', env.GITHUB_RUN_ATTEMPT || '1'],
  ].map(([label, value]) => `**${label}：** ${markdownText(redact(String(value || '未知'), secrets))}`).join('\n');

  return redactCardText({
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: 'CI 检查失败' }, template: 'red' },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: details },
        { tag: 'markdown', content: `**失败原因（日志末尾）**\n\n${fence}\n${reason}\n${fence}` },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看 CI 运行' },
          type: 'danger',
          behaviors: [{ type: 'open_url', default_url: runUrl }],
        },
      ],
    },
  }, secrets);
}

export async function run({ env = process.env, post = fetch, read = readLogWindow, readEnv = readEnvFile, log = console.log } = {}) {
  const webhook = (env.INPUT_WEBHOOK || '').trim();
  let secrets = secretValues(webhook, env['INPUT_REDACT-VALUES'] || '');
  const maskValues = secrets.filter((value) => value.trim().length >= 4);
  for (const value of maskValues) log(`::add-mask::${commandData(value)}`);
  const warning = (message) => log(`::warning::${commandData(redact(message, secrets))}`);

  if (!webhook) {
    log('未配置 FEISHU_CI_FAILURE_WEBHOOK，跳过飞书通知。');
    return 'skipped';
  }

  try {
    const checkStep = (env['INPUT_CHECK-STEP'] || '').trim() || 'check';
    let outcome = (env.INPUT_OUTCOME || '').trim();
    if (!outcome) {
      let steps;
      try { steps = JSON.parse(env.INPUT_STEPS || '{}'); }
      catch { throw new DiagnosticError('steps 不是有效 JSON，请传入 toJSON(steps)。'); }
      if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
        throw new DiagnosticError('steps 必须是步骤上下文对象，请传入 toJSON(steps)。');
      }
      if (!Object.hasOwn(steps, checkStep)) {
        throw new DiagnosticError('未找到目标检查步骤，请传入 outcome，或检查 check-step 和 steps 输入。');
      }
      outcome = steps[checkStep]?.outcome;
    }
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(outcome)) {
      throw new DiagnosticError('目标步骤 outcome 无效，应为 success、failure、cancelled 或 skipped。');
    }
    if (outcome !== 'failure') {
      log('目标检查步骤未失败，跳过飞书通知。');
      return 'skipped';
    }
    let url;
    try { url = new URL(webhook); } catch { throw new DiagnosticError('webhook 必须是有效的 HTTPS URL。'); }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new DiagnosticError('webhook 必须是有效的 HTTPS URL，且不能包含用户凭据。');
    }
    let configWarning = false;
    const envFile = (env['INPUT_REDACT-ENV-FILE'] || '').trim();
    if (envFile) {
      try {
        // Only read the explicitly configured, maintainer-trusted path. Keep
        // parsed values as array entries so multiline secrets remain intact.
        const values = Object.values(parseEnv(await readEnv(resolve(env.GITHUB_WORKSPACE || process.cwd(), envFile), 'utf8')));
        if (!values.length) throw new Error();
        const previous = new Set(secrets);
        secrets = secretValues(webhook, env['INPUT_REDACT-VALUES'] || '', values.filter((value) => value.length >= 8));
        for (const value of secrets) {
          if (!previous.has(value) && value.trim().length >= 4) log(`::add-mask::${commandData(value)}`);
        }
      } catch {
        // Neither paths nor parser/filesystem exceptions are safe diagnostics.
        // Without the configured secrets we must not read or send check logs.
        configWarning = true;
        warning('无法安全加载 redact-env-file，已省略检查日志。');
      }
    }
    const shortValues = secrets.filter((value) => value.trim().length < 4).length;
    if (shortValues) {
      warning(`有 ${shortValues} 个过短的脱敏值未注册为全局掩码，仍会从通知内容中隐藏。`);
    }
    const logFile = (env['INPUT_LOG-FILE'] || '').trim();
    const logPath = logFile ? resolve(env.GITHUB_WORKSPACE || process.cwd(), logFile) : '';
    const reason = configWarning ? sanitizeText(FALLBACK_REASON, secrets) : await logTail(logPath, secrets, read);
    const card = buildNotification(env, checkStep, reason, secrets);
    // Redact metadata too. Never print the payload or a raw network/API error.
    const body = JSON.stringify({ msg_type: 'interactive', card });
    let response;
    try {
      response = await post(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new DiagnosticError('飞书请求失败：网络异常、请求超时或被拒绝的重定向。');
    }
    if (!response.ok) throw new DiagnosticError(`飞书请求失败：HTTP ${response.status}。`);
    let result;
    try { result = await response.json(); } catch { throw new DiagnosticError('飞书返回了无效的 JSON 响应。'); }
    if (result?.code !== 0) throw new DiagnosticError('飞书拒绝消息，请检查机器人 webhook 及安全设置。');
    log('飞书 CI 失败通知已发送。');
    return configWarning ? 'warning' : 'sent';
  } catch (error) {
    if (error instanceof DiagnosticError) {
      warning(error.message);
    } else {
      warning('飞书通知发生内部异常，请开启步骤调试日志并检查 Action 实现。');
      const type = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : 'Error';
      log(`::debug::通知内部异常类型：${type}；为避免泄漏敏感信息，未输出异常原文。`);
    }
    return 'warning';
  }
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const status = await run();
  if (process.env.GITHUB_OUTPUT) {
    try { await appendFile(process.env.GITHUB_OUTPUT, `status=${status}\n`); }
    catch { console.log('::warning::无法写入 Action 的 status 输出。'); }
  }
}
