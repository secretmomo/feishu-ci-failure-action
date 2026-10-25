import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const LOCAL_TIMEOUT_MS = 30000;
const NETWORK_TIMEOUT_MS = 300000;
const MAX_GIT_BUFFER_BYTES = 16 * 1024 * 1024;
const SHORT_SHA_LENGTH = 12;

function safeDiagnostic(text) {
  return String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, '$1***@');
}

function formatCommand(args) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return `git ${args.map(quote).join(' ')}`;
}

class GitCommandError extends Error {
  constructor(args, result) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.signal || String(result.status ?? 'unknown');
    let message = `git ${args[0]} 失败：${safeDiagnostic(detail)}`;
    if (result.error?.code === 'ENOBUFS' && args[0] === 'status') {
      message = '工作区存在未提交或未跟踪的内容，状态输出超过容量；请清理本地文件或加入 .gitignore。';
    }
    super(message);
    this.code = result.error?.code;
  }
}

function readVersion(cwd) {
  let source;
  try { source = readFileSync(resolve(cwd, 'package.json'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`在 ${cwd} 未找到 package.json，请在项目中执行发布。`);
    throw new Error(`无法读取 ${resolve(cwd, 'package.json')}，请检查文件权限。`);
  }
  let pkg;
  try { pkg = JSON.parse(source); }
  catch { throw new Error('无法解析 package.json，请检查 JSON 语法。'); }
  if (!validVersion(pkg?.version)) throw new Error('package.json.version 必须是有效的语义版本号，例如 1.0.0。');
  return pkg.version;
}

function publishError(error, { tag, branch, tagRef, majorRef, pushArgs }) {
  const inspect = formatCommand(['ls-remote', '--refs', 'origin', `refs/heads/${branch}`, tagRef, majorRef]);
  const check = `先核对远端引用：\n${inspect}`;
  const retained = `本地标签 ${tag} 已保留。`;
  const recover = `如需重发同一版本，先确认远端未发布该版本，再执行 ${formatCommand(['tag', '-d', tag])}；否则请提升 package.json.version。`;
  // RPC failed 本身并不代表传输中断；HTTP 拒绝需要先解决具体原因。
  // 不仅凭 stderr 承诺远端绝无写入，恢复前仍需核对引用。
  if (error.code !== 'ETIMEDOUT' && /HTTP 4\d{2}\b|returned error: 4\d{2}\b/i.test(error.message)) {
    return new Error(`${error.message}\n\n${retained}服务端返回 HTTP 4xx：401/403 请检查凭据或权限，413 请检查推送体积；请先解决对应问题。${check}\n${recover}`);
  }
  // 传输阶段的 Git/curl 超时同样可能发生在服务端已经接收推送之后。
  if (error.code === 'ETIMEDOUT' || /operation timed out|timed out after \d+ ?(?:ms|milliseconds)|rpc failed;\s*curl\s+(?:18|28|52|55|56|92)\b|early eof|transfer closed|http\/2 stream|HTTP 5\d{2}\b|returned error: 5\d{2}\b/i.test(error.message)) {
    return new Error(`${error.message}\n\n远端状态未知：推送超时或传输中断，但服务端可能已完成原子推送。${check}\n核对前不要重试或删除本地标签 ${tag}。`);
  }
  if (/stale info|fetch first|non-fast-forward|but expected/i.test(error.message)) {
    return new Error(`${error.message}\n\n${retained}存在并发发布或分支非快进冲突。${check}\n执行 git fetch origin 并核对分支和发布版本；解决冲突后再决定如何发布，不要盲目覆盖旧 lease。\n${recover}`);
  }
  if (/\(already exists\)/i.test(error.message)) {
    return new Error(`${error.message}\n\n${retained}远端已存在同名版本标签，通常是并发发布；请提升 package.json.version 后重新发布。${check}`);
  }
  if (/does not support --atomic/i.test(error.message)) {
    return new Error(`${error.message}\n\n${retained}远端不支持原子推送，请使用支持该能力的服务端；脚本不会降级为分批推送。${check}`);
  }
  if (/could not resolve|failed to connect|connection (?:reset|closed|timed out)|remote end hung up|unexpected disconnect|broken pipe/i.test(error.message)) {
    return new Error(`${error.message}\n\n${retained}连接异常，远端状态可能未知。${check}\n仅在确认未完成发布且原 lease 仍有效后，可重试：\n${formatCommand(pushArgs)}`);
  }
  return new Error(`${error.message}\n\n${retained}${check}\n请先解决 Git 报告的问题；脚本不会自动重试推送。\n${recover}`);
}

function validVersion(version) {
  if (typeof version !== 'string') return false;
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  return Boolean(match) && match[0] === version && !(match[4] || '').split('.').some((part) => /^0\d+$/.test(part));
}

/**
 * runCommand 与 spawnSync(command, args, options) 同步调用契约一致：
 * 返回 { status: number | null, stdout?: string, stderr?: string, error?: Error, signal?: string }。
 * encoding 固定为 utf8；省略 stdout/stderr 时按空输出处理。
 */
export function release({ cwd = projectRoot, log = console.log, runCommand = spawnSync } = {}) {
  // 全部 Git 参数通过数组传递，不经过 shell，避免分支名等内容被当成命令。
  function git(args, allowedStatuses = [0]) {
    const network = args[0] === 'ls-remote' || args[0] === 'push';
    const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
    // 尊重调用方显式设置的 SSH 客户端；默认 OpenSSH 禁止交互式凭据提示。
    if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
    const result = runCommand('git', args, {
      cwd, env, encoding: 'utf8', maxBuffer: MAX_GIT_BUFFER_BYTES,
      timeout: network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
    });
    if (result.error || !allowedStatuses.includes(result.status)) {
      throw new GitCommandError(args, result);
    }
    return { status: result.status, text: String(result.stdout ?? '').trim() };
  }

  const version = readVersion(cwd);
  const tag = `v${version}`;
  const tagRef = `refs/tags/${tag}`;
  // 具体版本不可覆盖；浮动标签指向本次发布，不保证最高版本或兼容性。
  // 预发布也推进 major；0.x 共用 v0，跨 minor 也可能破坏兼容。
  // 其他克隆同步已移动的标签需显式 force fetch 对应的单个 ref。
  const majorTag = `v${version.split('.')[0]}`;
  const majorRef = `refs/tags/${majorTag}`;
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
  if (branch.status !== 0) throw new Error('当前处于 detached HEAD，请先切换到要发布的分支。');
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]);
  if (head.status !== 0) {
    const branchRef = git(['show-ref', '--verify', '--quiet', `refs/heads/${branch.text}`], [0, 1]);
    if (branchRef.status === 1) throw new Error('当前分支还没有提交，请先提交代码再发布。');
    throw new Error('无法读取 HEAD 提交，请检查仓库状态。');
  }
  const commit = head.text;

  if (git(['status', '--porcelain', '--untracked-files=all']).text) {
    throw new Error('工作区存在未提交或未跟踪的内容，请先提交或通过 .gitignore 忽略本地文件。');
  }
  if (git(['show-ref', '--verify', '--quiet', tagRef], [0, 1]).status === 0) {
    throw new Error(`本地标签 ${tag} 已存在。如该版本尚未成功发布，可在核对远端后执行 ${formatCommand(['tag', '-d', tag])} 重试同一版本；否则请提升 package.json.version。`);
  }
  // 一次查询同时获取具体版本和 major，避免重复网络往返。按完整 ref 名
  // 区分结果，不依赖返回顺序；查询失败必须停止，不能当作“标签不存在”。
  const remoteTags = git(['ls-remote', '--tags', '--refs', 'origin', tagRef, majorRef]).text;
  const remoteRefs = new Map(remoteTags.split(/\r?\n/).filter(Boolean).map((line) => {
    const [oid, ref] = line.split(/\s+/);
    return [ref, oid];
  }));
  if (remoteRefs.has(tagRef)) {
    throw new Error(`远端标签 ${tag} 已存在，请更新 package.json.version 后再发布。`);
  }
  // 记录远端浮动标签当前的对象 ID。空字符串表示不存在；推送时使用显式
  // lease，只有远端仍保持这个状态才允许更新，避免覆盖其他人并发发布。
  const expectedMajor = remoteRefs.get(majorRef) || '';
  const lease = `--force-with-lease=${majorRef}:${expectedMajor}`;

  log(`准备发布 ${tag}，并更新 ${majorTag}（${branch.text}，${commit.slice(0, SHORT_SHA_LENGTH)}）`);
  git(['tag', '-a', tag, commit, '-m', `Release ${tag}`]);
  const branchRef = `${commit}:refs/heads/${branch.text}`;
  const majorUpdate = `${commit}:${majorRef}`;
  const pushArgs = ['push', '--atomic', lease, 'origin', branchRef, tagRef, majorUpdate];
  try {
    // 三个远端引用一次原子更新：当前分支、具体版本、major 浮动标签。
    // 仅 major 标签允许受 lease 保护的覆盖，分支和具体版本不强制更新。
    git(pushArgs);
  } catch (error) {
    throw publishError(error, { tag, branch: branch.text, tagRef, majorRef, pushArgs });
  }
  // 远端发布成功后再同步本地浮动标签。推送失败时不提前移动本地 major；
  // 同步本地失败也不能误报远端未发布，后续发布仍以远端状态作为 lease。
  let localMajorSynced = true;
  try {
    git(['update-ref', majorRef, commit]);
  } catch (error) {
    localMajorSynced = false;
    log(`警告：远端发布已成功，但本地 ${majorTag} 同步失败：${error.message}`);
  }
  log(localMajorSynced
    ? `发布成功：${tag}，远端和本地 ${majorTag} 已指向本次提交。`
    : `发布成功：${tag}（远端 ${majorTag} 已更新；本地 ${majorTag} 未同步）。\n可同步该标签：${formatCommand(['fetch', 'origin', `+${majorRef}:${majorRef}`])}`);
  return tag;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    release();
  } catch (error) {
    console.error(`发布失败：${error.message}`);
    process.exitCode = 1;
  }
}
