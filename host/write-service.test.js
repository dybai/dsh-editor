import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileService } from './write-service.js';

/** 手动放行的 promise 门（当前用不到，保留给后续在途测试）。 */
const SESSION = 's1';
const SCOPE = { sessionId: SESSION, workspaceRoot: 'D:\\workspace' };

/**
 * 注入用 fake fs：resolve 返回稳定的 target 占位，writeText 由测试编排
 * （resolve 成功值或 reject 一个 FsError 形状的错误）。
 */
function fakeFs({ resolveError, writeOutcome } = {}) {
  const writes = [];
  return {
    writes,
    async resolve(path, _opts) {
      if (resolveError !== undefined) throw resolveError;
      return { path };
    },
    async writeText(_target, content, expected, signal, _policy) {
      writes.push({ content, expected });
      if (writeOutcome === undefined || writeOutcome instanceof Error) throw writeOutcome;
      return writeOutcome;
    },
  };
}

const fakeSandboxPolicy = { resolve: () => ({ policy: 'session' }) };
const fakeSessions = { get: () => ({ id: SESSION }) };

function makeService(fsOverride) {
  const fs = fsOverride ?? fakeFs({ writeOutcome: { operation: 'update', version: 'v2' } });
  const service = createFileService(fs, fakeSandboxPolicy, fakeSessions);
  return { service, fs };
}

/** FsError 形状的错误（dsh-fs 的真实形状：code + message，无 RemoteError 标记）。 */
function fsError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.name = 'FsError';
  return error;
}

test('writeFile resolves with operation and version on success', async () => {
  const { service, fs } = makeService();
  const outcome = await service.writeFile(SCOPE, 'tst.txt', 'hello', 'v1');
  assert.deepEqual(outcome, { operation: 'update', version: 'v2' });
  assert.equal(fs.writes.length, 1);
  // baseVersion 携带 replaceIfVersion 意图
  assert.deepEqual(fs.writes[0].expected, { kind: 'replaceIfVersion', version: 'v1' });
  assert.equal(fs.writes[0].content, 'hello');
});

test('writeFile with empty baseVersion writes without version intent', async () => {
  const { service, fs } = makeService();
  await service.writeFile(SCOPE, 'tst.txt', 'hello', '');
  assert.equal(fs.writes[0].expected, undefined);
});

test('a stale FS rejection is rethrown with the RemoteError marker so the wire keeps FS_STALE_VERSION', async () => {
  // 宿主 fs 抛 FsError（无 isDSHRemoteError 标记）——网关会把它降级成
  // gateway/internal 只保留 message，客户端的 /stale/i 判定就会落空。
  // 写服务必须在传播前把它翻译成网关认的形状。
  const stale = fsError('FS_STALE_VERSION', 'cannot write "tst.txt": file changed since it was read');
  const { service } = makeService(fakeFs({ writeOutcome: stale }));
  await assert.rejects(
    service.writeFile(SCOPE, 'tst.txt', 'mine', 'v1'),
    (error) =>
      error instanceof Error &&
      error.isDSHRemoteError === true &&
      error.code === 'FS_STALE_VERSION' &&
      /file changed since it was read/.test(error.message) &&
      error.details !== undefined &&
      typeof error.details === 'object',
  );
});

test('a stale edit rejection (edit verb) carries the marker too', async () => {
  const stale = fsError('FS_STALE_VERSION', 'cannot edit "tst.txt": file changed since it was read');
  const { service } = makeService(fakeFs({ writeOutcome: stale }));
  await assert.rejects(
    service.writeFile(SCOPE, 'tst.txt', 'mine', 'v1'),
    (error) => error.isDSHRemoteError === true && error.code === 'FS_STALE_VERSION',
  );
});

test('other FS rejections propagate unchanged (no marker invented)', async () => {
  const notFound = fsError('FS_NOT_FOUND', 'cannot write "tst.txt": not found');
  const { service } = makeService(fakeFs({ writeOutcome: notFound }));
  await assert.rejects(
    service.writeFile(SCOPE, 'tst.txt', 'mine', 'v1'),
    (error) => error.isDSHRemoteError === undefined && error.code === 'FS_NOT_FOUND',
  );
});

test('payload validation rejects before any fs call', async () => {
  const { service, fs } = makeService();
  await assert.rejects(service.writeFile(SCOPE, '', 'x', 'v1'), /path.*non-empty/i);
  await assert.rejects(service.writeFile(SCOPE, 'tst.txt', 'x\u0000y', 'v1'), /NUL/);
  assert.equal(fs.writes.length, 0);
});
