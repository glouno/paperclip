import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const require = createRequire(import.meta.url);
const runNode = promisify(execFile);

const consumerTest = String.raw`
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [entrypoint, scenario] = process.argv.slice(1);
const phrase = 'database system is ready to accept connections';
const originalSpawn = cp.spawn;
let spawned;
let activeChild;
cp.spawn = (command, args) => {
  if (String(command) === 'taskkill') {
    assert.equal(process.platform, 'win32');
    assert.deepEqual(args, ['/pid', activeChild.pid.toString(), '/f', '/t']);
    activeChild.kill();
    return activeChild;
  }
  assert.equal(path.basename(String(command)), process.platform === 'win32' ? 'postgres.exe' : 'postgres');
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = -1;
  child.kill = () => {
    queueMicrotask(() => {
      child.emit('exit', 0, 'SIGINT');
      child.emit('close', 0, 'SIGINT');
    });
    return true;
  };
  activeChild = child;
  spawned(child);
  return child;
};
syncBuiltinESMExports();

try {
  const { default: EmbeddedPostgres } = await import(pathToFileURL(entrypoint).href);
  async function check(chunks, ready, label) {
    const logs = [];
    const instance = new EmbeddedPostgres({
      databaseDir: '/unused-synthetic-pg-consumer-no-real-db',
      port: 12345,
      persistent: true,
      onLog: (message) => logs.push(message),
      onError: () => {},
    });
    let child;
    const reachedSpawn = new Promise((resolve) => { spawned = resolve; });
    let outcome = 'pending';
    const start = instance.start();
    start.then(() => { outcome = 'ready'; }, () => { outcome = 'rejected'; });
    try {
      child = await reachedSpawn;
      for (const chunk of chunks) child.stderr.emit('data', Buffer.from(chunk));
      await setImmediate();
      assert.deepEqual(logs, chunks, label + ': original log chunks');
      if (ready) {
        assert.equal(outcome, 'ready', label + ': split readiness resolves');
        await start;
      } else {
        assert.equal(outcome, 'pending', label + ': incomplete readiness stays pending');
        if (scenario === 'error') {
          const failure = new Error('synthetic spawn failure');
          assert.throws(() => child.emit('error', failure), (error) => error === failure);
          assert.equal(outcome, 'pending', label + ': existing error event semantics');
        }
        child.emit('close', 1, null);
        let rejection = 'not rejected';
        await start.catch((reason) => { rejection = reason; });
        assert.equal(outcome, 'rejected', label + ': close rejects');
        assert.equal(rejection, undefined, label + ': existing rejection reason');
      }
    } finally {
      if (child) {
        child.emit('close', 1, null);
        await instance.stop();
      }
    }
  }

  if (scenario === 'splits') {
    for (let split = 1; split < phrase.length; split++) {
      await check([phrase.slice(0, split), phrase.slice(split)], true, 'split ' + split);
    }
    await check([...phrase], true, 'one byte per chunk');
  } else if (scenario === 'logs') {
    await check(['x'.repeat(8192), 'LOG: ' + phrase.slice(0, 45), phrase.slice(45) + '\n'], true, 'long preceding log');
    await check([phrase], true, 'whole phrase');
  } else {
    await check([phrase.slice(0, -1)], false, 'partial phrase');
    await check(['database system is starting up\n'], false, 'unrelated log');
  }
} finally {
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
}
`;

describe("installed embedded Postgres readiness consumer", () => {
  it.each([
    ["splits", "recognizes every readiness split and one-byte chunks"],
    ["logs", "keeps original log chunks and recognizes readiness after a long log"],
    ["close", "keeps partial readiness pending and preserves rejection on close"],
    ["error", "preserves the existing error event behavior"],
  ])("%s: %s", async (scenario) => {
    await runNode(process.execPath, [
      "--input-type=module",
      "-e",
      consumerTest,
      require.resolve("embedded-postgres"),
      scenario,
    ], { timeout: 10_000, maxBuffer: 16 * 1024 });
  });
});
