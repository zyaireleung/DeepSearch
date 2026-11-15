/**
 * nightly hot-reschedule 红灯测试（修复前应失败）
 *
 * 因果链：配置页改 nightlyTime / nightlyEnabled / nightlyModel 后，
 * 宿主对 root-volatile Config 只走 fiber.rawConfig 原地更新 + emit
 * loader/volatile-update，不 dispose/重启 fiber。旧实现 startNightlyTimer
 * 把 config 捕获进 setTimeout 闭包，volatile-update 后闭包里的 config 仍是旧的
 * → 到点仍用旧 time / 旧 enabled / 旧 model。
 *
 * 沙盒：注入 fake timers + 可变 config 快照，不真跑 nightly.py、不碰生产。
 */
import { strict as assert } from "node:assert";

const timers = [];
let seq = 0;
// fake timer：只登记不执行，用 advance() 手动推进，才能精确断言 self-re-arm
// id 用单调自增（不能用 length+1：shift 后 push 会撞 id，clearTimeout 删错项）
const fakeSetTimeout = (fn, delay) => {
  const id = ++seq;
  timers.push({ id, fn, delay });
  return id;
};
const fakeClearTimeout = (id) => {
  const i = timers.findIndex((t) => t.id === id);
  if (i >= 0) timers.splice(i, 1);
};
// 推进到最早到期的 timer 并触发一次（fire 时先从队列移除，模拟真实 setTimeout 语义）
const advance = async () => {
  if (!timers.length) return false;
  const t = timers.shift();
  await t.fn();
  return true;
};

let logs = [];
const ctx = { logger: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) } };

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

// ── 红灯 A：configGetter 在每次 tick 重新读取，改 config 后 timer 用最新值 ──
console.log("\n── A：timer 每次读最新 config（改时间/开关后无需重启生效）──");
const nightly = await import("./lib/nightly.js");

let enabled = true;
let hhmm = "09:10";
let runs = 0;
const seen = []; // 每次 fire 时 runNightly 收到的快照
// configGetter 每次返回最新快照
const configGetter = () => ({
  nightlyEnabled: enabled,
  nightlyTime: hhmm,
  nightlyModel: "prov:model-a",
  vaultPath: "/tmp/vault",
  modelProviders: { prov: { baseURL: "u", apiKeyEnv: "K", models: [] } },
});

nightly.startNightlyTimer(ctx, configGetter, { K: "key-a" }, {
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  runNightly: async (opts) => { runs++; seen.push({ vault: opts.vault, model: opts.modelConfig?.model ?? null }); return { ok: true, stdout: "", stderr: "", rc: 0 }; },
});

check("A1 首次调度挂了一个 timer", timers.length === 1, `实际 ${timers.length}`);

// timer fire 一次（真实 setTimeout 到点执行；这里手动推进）
await advance();
check("A2 timer fire 后 nightly 跑了一次", runs === 1, `实际 ${runs}`);
check("A3 fire 后自动重排（self-re-arm，清旧挂新恰好一个）", timers.length === 1, `实际 ${timers.length}`);

// 模拟配置页写 nightlyEnabled=false + emit volatile-update
enabled = false;
nightly.stopNightlyTimer();
nightly.startNightlyTimer(ctx, configGetter, {}, {
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  runNightly: async () => { runs++; return { ok: true, stdout: "", stderr: "", rc: 0 }; },
});
check("A4 关闭后 timer 被清空", timers.length === 0, `实际 ${timers.length}`);

// 重新打开 + 改时间，timer 用最新 hhmm
enabled = true; hhmm = "21:30";
nightly.startNightlyTimer(ctx, configGetter, {}, {
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  runNightly: async () => { runs++; return { ok: true, stdout: "", stderr: "", rc: 0 }; },
});
check("A5 重开后又挂一个 timer", timers.length === 1, `实际 ${timers.length}`);

// A6 关键：改 configGetter 返回的 model/vault 后，到点 runNightly 用最新值（非旧闭包）
let model = "prov:model-a"; let vault = "/tmp/vault-a";
const getterLive = () => ({ nightlyEnabled: true, nightlyTime: "21:30", nightlyModel: model, vaultPath: vault, modelProviders: { prov: { baseURL: "u", apiKeyEnv: "K", models: [] } } });
nightly.startNightlyTimer(ctx, getterLive, { K: "key-a" }, {
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  runNightly: async (o) => { runs++; seen.push({ vault: o.vault, model: o.modelConfig?.model ?? null }); return { ok: true, stdout: "", stderr: "", rc: 0 }; },
});
model = "prov:model-b"; vault = "/tmp/vault-b"; // 配置页改 model
await advance(); // 到点
check("A6 到点用最新 model（非启动时旧闭包）", seen.at(-1)?.model === "model-b", `实际 ${JSON.stringify(seen.at(-1))}`);
check("A6b 到点用最新 vault", seen.at(-1)?.vault === "/tmp/vault-b", `实际 ${JSON.stringify(seen.at(-1))}`);
check("A6c 到点后仍 self-re-arm", timers.length === 1, `实际 ${timers.length}`);

// ── 红灯 B：index.js 有 loader/volatile-update 监听（代码层断言）─────────
console.log("\n── B：index.js 有 volatile-update 监听（否则靠重启才生效）──");
const indexSrc = (await import("node:fs")).readFileSync("./lib/index.js", "utf-8");
check("B1 index.js 出现 loader/volatile-update 监听", indexSrc.includes("loader/volatile-update"),
  "未找到 loader/volatile-update");
check("B2 index.js 监听里重排 nightly timer（引用 startNightlyTimer）",
  indexSrc.includes("loader/volatile-update") && indexSrc.includes("startNightlyTimer"),
  "监听未引用 startNightlyTimer");

// ── 红灯 C：apply() 能从 bundle patch 磁盘读到 vaultPath（配置页浅覆盖抹掉 vault 的兜底）────
console.log("\n── C：apply() 有 bundle-patch vaultPath 磁盘兜底（配置页浅覆盖后仍有 vault）──");
const hasBundleRead = indexSrc.includes("readVaultPathFromBundle");
check("C1 index.js 定义 readVaultPathFromBundle（读 bundle cordis.patch.yml）", hasBundleRead,
  "未找到 readVaultPathFromBundle");
check("C2 apply 的 vault 链接了 bundle 兜底", hasBundleRead && /configVault\s*\|\|\s*expandVaultPath\(readVaultPathFromBundle/.test(indexSrc),
  "vault 链未接 readVaultPathFromBundle 兜底");
// bundle patch 真的含 vaultPath（生产三副本已确认，这里读工作区副本）
const patchSrc = (await import("node:fs")).readFileSync("./cordis.patch.yml", "utf-8");
check("C3 bundle cordis.patch.yml 声明了 vaultPath", /^\s*vaultPath:\s*\S+/m.test(patchSrc),
  "bundle patch 无 vaultPath");

console.log(`\n══ ${pass} pass / ${fail} fail ══`);
process.exit(fail ? 1 : 0);
