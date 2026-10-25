import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { release } from './release.mjs';

// 只隔离 Git 子进程，不改写 process.env，支持共享进程中的其他测试。
let configDir;
let emptyConfig;
test.before(() => {
  configDir = mkdtempSync(join(tmpdir(), 'feishu-git-config-'));
  emptyConfig = join(configDir, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
});
test.after(() => rmSync(configDir, { recursive: true, force: true }));

function spawnGitCommand(command, args, options) {
  const env = {
    ...(options.env ?? process.env),
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
  };
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_TEMPLATE_DIR;
  return spawnSync(command, args, { ...options, env });
}

function git(cwd, args, allowFailure = false) {
  const result = spawnGitCommand('git', args, { cwd, encoding: 'utf8', timeout: 10000 });
  if (!allowFailure) assert.equal(result.status, 0, result.error?.message || result.stderr);
  return { status: result.status, text: result.stdout.trim() };
}

function fixture(t, version = '1.0.0') {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'work');
  const remote = join(dir, 'remote.git');
  git(dir, ['init', '--template=', '--bare', remote]);
  git(dir, ['init', '--template=', '-b', 'main', cwd]);
  mkdirSync(join(remote, 'hooks'), { recursive: true });
  mkdirSync(join(cwd, '.git/hooks'), { recursive: true });
  git(cwd, ['config', 'user.name', 'Release Test']);
  git(cwd, ['config', 'user.email', 'release-test@example.invalid']);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', version }));
  git(cwd, ['add', 'package.json']);
  git(cwd, ['commit', '-m', 'initial']);
  git(cwd, ['remote', 'add', 'origin', remote]);
  git(cwd, ['push', 'origin', 'main']);
  const localGit = (args, allowFailure) => git(cwd, args, allowFailure);
  const remoteGit = (args, allowFailure) => git(dir, ['--git-dir', remote, ...args], allowFailure);
  const logs = [];
  return { cwd, remote, git: localGit, remoteGit, logs, runCommand: spawnGitCommand, log: (message) => logs.push(message) };
}

test('release creates an annotated version tag and pushes the current commit atomically', (t) => {
  const f = fixture(t);
  const pkg = join(f.cwd, 'package.json');
  writeFileSync(pkg, JSON.stringify({ name: 'fixture', version: '1.0.0', description: 'ready' }));
  f.git(['add', 'package.json']);
  f.git(['commit', '-m', 'ready']);
  const head = f.git(['rev-parse', 'HEAD']).text;
  assert.equal(release(f), 'v1.0.0');
  assert.equal(f.git(['cat-file', '-t', 'refs/tags/v1.0.0']).text, 'tag');
  assert.match(f.git(['cat-file', '-p', 'refs/tags/v1.0.0']).text, /\n\nRelease v1\.0\.0\n?$/);
  assert.equal(f.remoteGit(['rev-parse', 'v1.0.0^{commit}']).text, head);
  assert.equal(f.remoteGit(['rev-parse', 'main']).text, head);
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1']).text, head);
  assert.equal(f.git(['rev-parse', 'refs/tags/v1']).text, head);
  assert.ok(f.logs.some((line) => line.includes('发布成功：v1.0.0')));
});

test('existing local version tags abort without changing the remote', (t) => {
  const f = fixture(t);
  f.git(['tag', 'v1.0.0']);
  assert.throws(() => release(f), (error) => {
    assert.match(error.message, /本地标签 v1\.0\.0 已存在/);
    assert.match(error.message, /尚未成功发布.*核对远端/);
    assert.ok(error.message.includes("git 'tag' '-d' 'v1.0.0'"));
    assert.match(error.message, /提升 package.json.version/);
    return true;
  });
  assert.equal(f.remoteGit(['show-ref', '--verify', '--quiet', 'refs/tags/v1.0.0'], true).status, 1);
});

test('existing remote tags abort without creating or overwriting a local tag', (t) => {
  const f = fixture(t);
  f.remoteGit(['tag', 'v1.0.0', 'main']);
  const remoteTag = f.remoteGit(['rev-parse', 'refs/tags/v1.0.0']).text;
  assert.throws(() => release(f), (error) => {
    assert.match(error.message, /远端标签 v1\.0\.0 已存在/);
    assert.ok(!error.message.includes("git 'tag' '-d'"));
    return true;
  });
  assert.equal(f.git(['show-ref', '--verify', '--quiet', 'refs/tags/v1.0.0'], true).status, 1);
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1.0.0']).text, remoteTag);
});

for (const state of ['modified', 'untracked']) {
  test(`a ${state} working tree prevents release`, (t) => {
    const f = fixture(t);
    if (state === 'modified') {
      writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ name: 'changed', version: '1.0.0' }));
    } else {
      writeFileSync(join(f.cwd, 'untracked.txt'), 'local data');
    }
    assert.throws(() => release(f), /工作区存在未提交或未跟踪/);
    assert.equal(f.git(['show-ref', '--verify', '--quiet', 'refs/tags/v1.0.0'], true).status, 1);
  });
}

test('invalid semantic versions are rejected before creating tags', (t) => {
  const f = fixture(t);
  for (const version of [undefined, '', 1, 'v1.0.0', '1.2', '01.0.0', '1.0.0-01', '1.0.0 ', '1.0.0\n']) {
    writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ name: 'fixture', version }));
    assert.throws(() => release(f), /有效的语义版本号/);
  }
  assert.equal(f.git(['tag', '--list']).text, '');
});

test('prerelease and build identifiers are taken directly from package.json', (t) => {
  const f = fixture(t, '1.2.3-rc.1+build.5');
  assert.equal(release(f), 'v1.2.3-rc.1+build.5');
  assert.equal(f.remoteGit(['rev-parse', 'v1.2.3-rc.1+build.5^{commit}']).text, f.git(['rev-parse', 'HEAD']).text);
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1']).text, f.git(['rev-parse', 'HEAD']).text);
});

test('a failed remote query is not mistaken for a missing tag', (t) => {
  const f = fixture(t);
  f.git(['remote', 'set-url', 'origin', join(f.cwd, 'nonexistent.git')]);
  assert.throws(() => release(f), /ls-remote 失败/);
  assert.equal(f.git(['tag', '--list']).text, '');
});

test('one remote query obtains both version and major refs while preserving the major lease', (t) => {
  const f = fixture(t, '3.2.1');
  f.git(['tag', '-a', 'v3', '-m', 'existing major']);
  f.git(['push', 'origin', 'refs/tags/v3']);
  const traceFile = join(f.cwd, '..', 'git-trace.jsonl');
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = traceFile;
  t.after(() => {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  });
  assert.equal(release(f), 'v3.2.1');
  const queries = readFileSync(traceFile, 'utf8').trim().split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === 'start' && event.argv?.includes('ls-remote'));
  assert.equal(queries.length, 1);
  assert.ok(queries[0].argv.includes('refs/tags/v3.2.1'));
  assert.ok(queries[0].argv.includes('refs/tags/v3'));
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v3']).text, f.git(['rev-parse', 'HEAD']).text);
});

test('detached HEAD prevents publication', (t) => {
  const f = fixture(t);
  f.git(['checkout', '--detach']);
  assert.throws(() => release(f), /detached HEAD/);
  assert.equal(f.git(['tag', '--list']).text, '');
});

test('a rejected atomic push retains the version tag and leaves remote refs and local major unchanged', (t) => {
  const f = fixture(t);
  const oldHead = f.remoteGit(['rev-parse', 'main']).text;
  f.git(['tag', 'v1']);
  f.git(['push', 'origin', 'refs/tags/v1']);
  const pkg = join(f.cwd, 'package.json');
  writeFileSync(pkg, JSON.stringify({ name: 'fixture', version: '1.0.0', description: 'new commit' }));
  f.git(['add', 'package.json']);
  f.git(['commit', '-m', 'new commit']);
  writeFileSync(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.throws(() => release(f), /本地标签 v1\.0\.0 已保留/);
  assert.equal(f.remoteGit(['rev-parse', 'main']).text, oldHead);
  assert.equal(f.remoteGit(['show-ref', '--verify', '--quiet', 'refs/tags/v1.0.0'], true).status, 1);
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1']).text, oldHead);
  assert.equal(f.git(['rev-parse', 'refs/tags/v1']).text, oldHead);
  assert.equal(f.git(['rev-parse', 'v1.0.0^{commit}']).text, f.git(['rev-parse', 'HEAD']).text);
  assert.equal(JSON.parse(readFileSync(pkg, 'utf8')).version, '1.0.0');
});

test('a new patch moves existing local and remote major tags without changing old version tags', (t) => {
  const f = fixture(t, '1.0.1');
  const oldHead = f.git(['rev-parse', 'HEAD']).text;
  // 兼容历史上以附注标签发布的 major，lease 应使用标签对象 ID 而非提交 ID。
  f.git(['tag', '-a', 'v1', '-m', 'old major']);
  f.git(['tag', '-a', 'v1.0.0', '-m', 'old version']);
  f.git(['push', 'origin', 'refs/tags/v1', 'refs/tags/v1.0.0']);
  const oldVersion = f.remoteGit(['rev-parse', 'refs/tags/v1.0.0']).text;
  writeFileSync(join(f.cwd, 'new.txt'), 'next patch');
  f.git(['add', 'new.txt']);
  f.git(['commit', '-m', 'next patch']);
  const head = f.git(['rev-parse', 'HEAD']).text;
  assert.notEqual(head, oldHead);
  assert.equal(release(f), 'v1.0.1');
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1']).text, head);
  assert.equal(f.git(['rev-parse', 'refs/tags/v1']).text, head);
  assert.equal(f.remoteGit(['rev-parse', 'v1.0.1^{commit}']).text, head);
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1.0.0']).text, oldVersion);
});

test('major is derived from the package version and other major tags stay unchanged', (t) => {
  const f = fixture(t, '2.3.0');
  f.remoteGit(['tag', 'v1', 'main']);
  const oldMajor = f.remoteGit(['rev-parse', 'refs/tags/v1']).text;
  assert.equal(release(f), 'v2.3.0');
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v2']).text, f.git(['rev-parse', 'HEAD']).text);
  assert.equal(f.git(['rev-parse', 'refs/tags/v2']).text, f.git(['rev-parse', 'HEAD']).text);
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1']).text, oldMajor);
});

test('a concurrent major update rejects the entire push rather than overwriting another release', (t) => {
  const f = fixture(t);
  const oldHead = f.git(['rev-parse', 'HEAD']).text;
  f.git(['tag', 'v1']);
  f.git(['push', 'origin', 'refs/tags/v1']);
  writeFileSync(join(f.cwd, 'new.txt'), 'concurrent release');
  f.git(['add', 'new.txt']);
  f.git(['commit', '-m', 'concurrent']);
  const newHead = f.git(['rev-parse', 'HEAD']).text;
  // 将对象送入临时远端，随后 pre-push 在远端引用检查之后模拟另一位发布者。
  f.git(['push', 'origin', `${newHead}:refs/heads/competitor`]);
  const previousRemote = process.env.RELEASE_TEST_REMOTE;
  const previousCommit = process.env.RELEASE_TEST_COMMIT;
  process.env.RELEASE_TEST_REMOTE = f.remote;
  process.env.RELEASE_TEST_COMMIT = newHead;
  t.after(() => {
    if (previousRemote === undefined) delete process.env.RELEASE_TEST_REMOTE;
    else process.env.RELEASE_TEST_REMOTE = previousRemote;
    if (previousCommit === undefined) delete process.env.RELEASE_TEST_COMMIT;
    else process.env.RELEASE_TEST_COMMIT = previousCommit;
  });
  writeFileSync(join(f.cwd, '.git/hooks/pre-push'), '#!/bin/sh\ngit --git-dir "$RELEASE_TEST_REMOTE" update-ref refs/tags/v1 "$RELEASE_TEST_COMMIT"\n', { mode: 0o755 });
  assert.throws(() => release(f), (error) => {
    assert.match(error.message, /并发发布或分支非快进冲突/);
    assert.ok(error.message.includes("git 'tag' '-d' 'v1.0.0'"));
    assert.ok(!error.message.includes('可重试：'));
    return true;
  });
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1']).text, newHead);
  assert.equal(f.remoteGit(['rev-parse', 'main']).text, oldHead);
  assert.equal(f.remoteGit(['show-ref', '--verify', '--quiet', 'refs/tags/v1.0.0'], true).status, 1);
  assert.equal(f.git(['rev-parse', 'refs/tags/v1']).text, oldHead);
});

test('a non-fast-forward branch rejection leaves the branch and all release refs unchanged', (t) => {
  const f = fixture(t);
  const oldHead = f.git(['rev-parse', 'HEAD']).text;
  f.git(['tag', 'v1']);
  f.git(['push', 'origin', 'refs/tags/v1']);
  f.git(['checkout', '-b', 'competitor']);
  writeFileSync(join(f.cwd, 'new.txt'), 'remote advance');
  f.git(['add', 'new.txt']);
  f.git(['commit', '-m', 'remote advance']);
  const remoteHead = f.git(['rev-parse', 'HEAD']).text;
  f.git(['push', 'origin', `${remoteHead}:refs/heads/main`]);
  f.git(['checkout', 'main']);
  assert.throws(() => release(f), (error) => {
    assert.match(error.message, /并发发布或分支非快进冲突/);
    assert.ok(error.message.includes("git 'tag' '-d' 'v1.0.0'"));
    assert.ok(!error.message.includes('可重试：'));
    return true;
  });
  assert.equal(f.remoteGit(['rev-parse', 'main']).text, remoteHead);
  assert.equal(f.remoteGit(['show-ref', '--verify', '--quiet', 'refs/tags/v1.0.0'], true).status, 1);
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1']).text, oldHead);
  assert.equal(f.git(['rev-parse', 'refs/tags/v1']).text, oldHead);
});

test('push timeouts explicitly report unknown remote state without suggesting a retry', (t) => {
  const f = fixture(t);
  const optionsSeen = [];
  assert.throws(() => release({ ...f, runCommand(command, args, options) {
    optionsSeen.push({ command: args[0], options });
    if (args[0] === 'push') return { error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
    return spawnGitCommand(command, args, options);
  } }), (error) => {
    assert.match(error.message, /远端状态未知/);
    assert.ok(!error.message.includes('可重试：'));
    assert.ok(!error.message.includes('已保留'));
    assert.ok(!error.message.includes("git 'tag' '-d'"));
    return true;
  });
  for (const { command, options } of optionsSeen) {
    assert.equal(options.timeout, ['ls-remote', 'push'].includes(command) ? 300000 : 30000);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  }
});

test('transient connection errors provide a safely quoted conditional retry command', (t) => {
  const f = fixture(t);
  f.git(['checkout', '-b', "release/it's-ready"]);
  assert.throws(() => release({ ...f, runCommand(command, args, options) {
    if (args[0] === 'push') return { status: 128, stderr: 'fatal: Connection reset by peer', stdout: '' };
    return spawnGitCommand(command, args, options);
  } }), (error) => {
    assert.match(error.message, /远端状态可能未知/);
    assert.match(error.message, /确认未完成发布且原 lease 仍有效后，可重试/);
    assert.ok(error.message.includes("it'\\''s-ready"));
    assert.ok(error.message.includes('--force-with-lease=refs/tags/v1:'));
    return true;
  });
});

test('an atomic-incompatible server is rejected without suggesting non-atomic fallback', (t) => {
  const f = fixture(t);
  assert.throws(() => release({ ...f, runCommand(command, args, options) {
    if (args[0] === 'push') return { status: 128, stderr: 'fatal: the receiving end does not support --atomic push', stdout: '' };
    return spawnGitCommand(command, args, options);
  } }), (error) => {
    assert.match(error.message, /远端不支持原子推送/);
    assert.match(error.message, /不会降级为分批推送/);
    assert.ok(!error.message.includes("git 'tag' '-d'"));
    assert.ok(!error.message.includes('可重试：'));
    return true;
  });
});

test('local major sync failure is distinct from remote publication success', (t) => {
  const f = fixture(t);
  const oldHead = f.git(['rev-parse', 'HEAD']).text;
  f.git(['tag', 'v1']);
  f.git(['push', 'origin', 'refs/tags/v1']);
  writeFileSync(join(f.cwd, 'new.txt'), 'next');
  f.git(['add', 'new.txt']);
  f.git(['commit', '-m', 'next']);
  const head = f.git(['rev-parse', 'HEAD']).text;
  assert.equal(release({ ...f, runCommand(command, args, options) {
    if (args[0] === 'update-ref') return { status: 128, stderr: 'test: local ref is locked', stdout: '' };
    return spawnGitCommand(command, args, options);
  } }), 'v1.0.0');
  assert.equal(f.remoteGit(['rev-parse', 'refs/tags/v1']).text, head);
  assert.equal(f.git(['rev-parse', 'refs/tags/v1']).text, oldHead);
  assert.match(f.logs.at(-1), /发布成功：v1\.0\.0（远端 v1 已更新；本地 v1 未同步）/);
  assert.ok(f.logs.at(-1).includes('+refs/tags/v1:refs/tags/v1'));
  assert.ok(!f.logs.at(-1).includes('远端和本地'));
});

test('large status output and ENOBUFS explain the dirty worktree rather than exposing an internal error', (t) => {
  const f = fixture(t);
  for (const overflow of [false, true]) {
    assert.throws(() => release({ ...f, runCommand(command, args, options) {
      if (args[0] === 'status') {
        assert.equal(options.maxBuffer, 16 * 1024 * 1024);
        return overflow
          ? { error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }) }
          : { status: 0, stdout: '?? untracked.txt\n'.repeat(100000), stderr: '' };
      }
      return spawnGitCommand(command, args, options);
    } }), (error) => {
      assert.match(error.message, /工作区存在未提交或未跟踪/);
      assert.ok(!error.message.includes('ENOBUFS'));
      return true;
    });
  }
});

test('missing and invalid package.json files have actionable diagnostics', (t) => {
  const f = fixture(t);
  const path = join(f.cwd, 'package.json');
  rmSync(path);
  assert.throws(() => release(f), /未找到 package\.json/);
  writeFileSync(path, '{');
  assert.throws(() => release(f), /无法解析 package\.json/);
});

test('unborn branches report that a commit is needed', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'feishu-unborn-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ['init', '--template=', '-b', 'main']);
  writeFileSync(join(cwd, 'package.json'), '{"version":"1.0.0"}');
  assert.throws(() => release({ cwd, log: () => {}, runCommand: spawnGitCommand }), /当前分支还没有提交/);
});

test('Git diagnostic URLs hide user info and explicit SSH configuration is preserved', (t) => {
  const f = fixture(t);
  const previous = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'custom-ssh --batch';
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previous;
  });
  assert.throws(() => release({ ...f, runCommand(_command, _args, options) {
    assert.equal(options.env.GIT_SSH_COMMAND, 'custom-ssh --batch');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    return { status: 128, stderr: 'fatal: https://user:private-token@example.invalid/repo.git', stdout: '' };
  } }), (error) => {
    assert.ok(error.message.includes('https://***@example.invalid/repo.git'));
    assert.ok(!error.message.includes('private-token'));
    assert.ok(!error.message.includes('user:'));
    return true;
  });
});

test('real Git remote diagnostics also hide embedded URL credentials', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\necho "fatal: https://user:private-token@example.invalid/repo.git" >&2\nexit 1\n', { mode: 0o755 });
  assert.throws(() => release(f), (error) => {
    assert.ok(error.message.includes('https://***@example.invalid/repo.git'));
    assert.ok(!error.message.includes('private-token'));
    return true;
  });
});

test('transport failures report unknown state without retry or tag deletion commands', (t) => {
  const f = fixture(t);
  for (const stderr of [
    'fatal: Operation timed out after 300002 milliseconds with 0 bytes received',
    'error: RPC failed; curl 28 Operation timed out',
    ...[18, 52, 55, 56, 92].map((code) => `error: RPC failed; curl ${code} transport interrupted`),
    'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
    'fatal: The requested URL returned error: 503',
    'fatal: early EOF', 'fatal: transfer closed', 'HTTP/2 stream 1 was not closed cleanly',
  ]) {
    // 每轮都创建本地版本标签，因此仅清理临时仓库中的该标签后再测下一诊断。
    f.git(['tag', '-d', 'v1.0.0'], true);
    assert.throws(() => release({ ...f, runCommand(command, args, options) {
      if (args[0] === 'push') return { status: 128, stderr };
      return spawnGitCommand(command, args, options);
    } }), (error) => {
      assert.match(error.message, /远端状态未知/);
      assert.match(error.message, /核对前不要重试或删除/);
      assert.ok(!error.message.includes('可重试：'));
      assert.ok(!error.message.includes("git 'tag' '-d'"));
      return true;
    });
  }
});

test('a concurrent version-tag creation directs the publisher to increase the version', (t) => {
  const f = fixture(t);
  assert.throws(() => release({ ...f, runCommand(command, args, options) {
    if (args[0] === 'push') return { status: 1, stderr: '! [rejected] v1.0.0 -> v1.0.0 (already exists)' };
    return spawnGitCommand(command, args, options);
  } }), (error) => {
    assert.match(error.message, /远端已存在同名版本标签/);
    assert.match(error.message, /并发发布；请提升 package.json.version/);
    assert.ok(!error.message.includes('先确认远端未发布该版本'));
    assert.ok(!error.message.includes("git 'tag' '-d'"));
    assert.ok(!error.message.includes('可重试：'));
    return true;
  });
});

test('HTTP client errors give actionable rejection diagnostics before generic RPC or EOF errors', (t) => {
  const f = fixture(t);
  for (const status of [401, 403, 413]) {
    f.git(['tag', '-d', 'v1.0.0'], true);
    assert.throws(() => release({ ...f, runCommand(command, args, options) {
      if (args[0] === 'push') return {
        status: 128,
        stderr: `error: RPC failed; HTTP ${status} curl 22 The requested URL returned error: ${status}\nfatal: early EOF`,
      };
      return spawnGitCommand(command, args, options);
    } }), (error) => {
      assert.match(error.message, /HTTP 4xx/);
      assert.match(error.message, /凭据或权限/);
      assert.match(error.message, /推送体积/);
      assert.ok(!error.message.includes('远端状态未知'));
      assert.ok(!error.message.includes('核对前不要重试'));
      assert.ok(!error.message.includes('可重试：'));
      return true;
    });
  }
});

test('connection establishment timeouts retain their conditional retry guidance', (t) => {
  const f = fixture(t);
  assert.throws(() => release({ ...f, runCommand(command, args, options) {
    if (args[0] === 'push') return { status: 128, stderr: 'Failed to connect to example.invalid: Connection timed out' };
    return spawnGitCommand(command, args, options);
  } }), (error) => {
    assert.match(error.message, /确认未完成发布且原 lease 仍有效后，可重试/);
    assert.ok(!error.message.includes('核对前不要重试'));
    return true;
  });
});

test('command wrappers may omit output fields without producing TypeError or undefined diagnostics', (t) => {
  const f = fixture(t);
  assert.throws(() => release({ ...f, runCommand: () => ({ status: 1 }) }), /detached HEAD/);
  assert.throws(() => release({ ...f, runCommand: () => ({}) }), /git symbolic-ref 失败：unknown/);
  assert.throws(() => release({ ...f, runCommand(command, args, options) {
    if (args[0] === 'push') return { status: 128 };
    return spawnGitCommand(command, args, options);
  } }), /git push 失败：128/);
});

test('default SSH BatchMode is used only when neither SSH override is set', (t) => {
  const f = fixture(t);
  const previous = new Map(['GIT_SSH_COMMAND', 'GIT_SSH'].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;
  for (const override of [undefined, 'custom-ssh']) {
    if (override) process.env.GIT_SSH = override;
    assert.throws(() => release({ ...f, runCommand(_command, _args, options) {
      assert.equal(options.env.GIT_SSH_COMMAND, override ? undefined : 'ssh -oBatchMode=yes');
      assert.equal(options.env.GIT_SSH, override);
      return { status: 128, stderr: 'test: stop before mutation' };
    } }), /stop before mutation/);
  }
});
