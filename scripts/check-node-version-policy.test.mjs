import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const repo = new URL("../", import.meta.url);
const generatedRoots = ["packages/paperclip-runner/provider-assets", "server/provider-assets"];

function fixture(t) {
  const container = mkdtempSync(join(tmpdir(), "paperclip-node-policy-"));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  let root = join(container, "source");
  mkdirSync(root);
  const write = (name, content) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  };
  for (const name of [
    "scripts/check-node-version-policy.mjs", "scripts/node-image-policy.mjs",
    ".nvmrc", "packages/shared/src/node-version.ts", "scripts/install.sh",
    "docker/agent-runtime/Dockerfile.base", "packages/adapter-utils/src/sandbox-install-command.ts",
    "packages/plugins/sandbox-providers/exe-dev/src/plugin.ts",
    "packages/plugins/sandbox-providers/modal/src/manifest.ts", "cli/esbuild.config.mjs",
    "packages/plugins/sdk/src/bundlers.ts", "scripts/generate-npm-package-json.mjs",
  ]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    copyFileSync(new URL(name, repo), join(root, name));
  }
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  const manifest = (name, fields = {}) => write(name, JSON.stringify({
    name: "synthetic-policy-fixture", engines: { node: ">=24.11.0" }, ...fields,
  }));
  manifest("package.json");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: "pipe", timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(container, "absent-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const run = () => {
    const result = spawnSync(process.execPath, [join(root, "scripts/check-node-version-policy.mjs")], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  };
  return {
    manifest, write, git, run,
    removeIdentity: () => rmSync(join(root, ".git"), { recursive: true }),
    link: () => {
      const linked = join(container, "linked");
      git("worktree", "add", "--quiet", "--detach", linked, "HEAD");
      root = linked;
      mkdirSync(join(root, ".github/workflows"), { recursive: true });
    },
  };
}

for (const linked of [false, true]) {
  test(`ignores installed assets in both generated roots (${linked ? "linked" : "normal"} checkout)`, t => {
    const f = fixture(t);
    if (linked) f.link();
    for (const root of generatedRoots) {
      f.manifest(`${root}/provider/distribution/package.json`, { engines: {}, dependencies: { "@types/node": "^22.0.0" } });
      f.write(`${root}/provider/Dockerfile`, "FROM node:22\n");
    }
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const root of generatedRoots) {
  for (const linked of [false, true]) {
    test(`checks tracked authored manifests in ${root} (${linked ? "linked" : "normal"} checkout)`, t => {
      const f = fixture(t);
      if (linked) f.link();
      const name = `${root}/authored/package.json`;
      f.manifest(name, { engines: {} });
      f.git("add", name);
      const result = f.run();
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(join(name)), result.stderr);
      assert.match(result.stderr, /engines.node must be >=24.11.0, found missing/);
    });
  }
}

for (const name of ["packages/authored/package.json", "packages/other/provider-assets/package.json", "packages/paperclip-runner/provider-assets-other/package.json"]) {
  test(`retains authored checks for ${name}`, t => {
    const f = fixture(t);
    f.manifest(name, { engines: { node: ">=22.0.0" } });
    const result = f.run();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(join(name)), result.stderr);
  });
}

test("retains Node type, Docker, workflow and required-source checks", t => {
  const f = fixture(t);
  f.manifest("packages/authored/package.json", { devDependencies: { "@types/node": "^22.0.0" } });
  f.write("docker/authored/Dockerfile", "FROM node:22\n");
  f.write(".github/workflows/authored.yml", "node-version: 22\n");
  f.write(".nvmrc", "22\n");
  const result = f.run();
  assert.equal(result.status, 1);
  for (const message of ["@types/node", "Node base image", "node-version must be 24", ".nvmrc"]) {
    assert.ok(result.stderr.includes(message), result.stderr);
  }
});

test("rejects missing Git identity instead of excluding authored source", t => {
  const f = fixture(t);
  f.removeIdentity();
  f.manifest(`${generatedRoots[0]}/authored/package.json`, { engines: {} });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Git source identity is unavailable/);
});
