// read-query-guard v0.1.0
//
// Read-only query tool-choice lint. When the model reaches for bash to run a
// plain read-only query (`cat`/`find`/`rg`/`grep`/...), deny it and point at the
// zero-permission native tool (`read`/`glob`/`grep`). Those tools read without
// going through the bash sandbox, so they never trigger an approval prompt;
// running the same query through bash can.
//
// Real DSH contract (mirrors browser-route-guard, verified against 0.2.2-rc.1):
//   export const inject = ["tools"], export function apply(ctx)
//   ctx.tools.guard(exec => string | undefined)   // return reason to deny

// Zero-permission native tools available to the model.
const NATIVE = { cat: "read", find: "glob", rg: "grep", grep: "grep" };

// ponytail: split on pipe/semicolon and take the first segment = "command
// position". Anything piped or sequenced (`ps | grep`, `a; grep`) is NOT the
// lead command, so it is allowed. This is not a shell parser — a redirect or
// heredoc that hides a pipe is simply allowed (safe direction: we over-allow,
// never over-deny).
export function commandPosition(cmd) {
  const lead = String(cmd ?? "").split(/[|;]/)[0].trim();
  const tokens = lead.split(/\s+/);
  // strip leading VAR=value env assignments
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens[i] ?? "";
}

// ponytail: fail-closed substring/flag scan, NOT a shell parser. Boundary: a
// grep pattern that literally contains a `>` (e.g. grep 'a>b') is over-allowed
// — accepted by design, an over-allow only keeps bash running, never weakens
// anything. We only ever DENY the plain read-only case.
export function denyReason(toolName, args = {}) {
  if (toolName !== "bash") return undefined;
  const cmd = String(args?.command ?? "");
  if (!cmd.trim()) return undefined;
  // any redirect / heredoc = the command writes or does real shell IO -> allow
  if (/>>?|<<|-delete\b|-exec\b/.test(cmd)) return undefined;
  const head = commandPosition(cmd);
  const native = NATIVE[head];
  if (!native) return undefined;
  return [
    `只读查询禁止用 bash 的 \`${head}\`：改用零权限工具 \`${native}\`。`,
    `\`read\` 读文件、\`glob\` 按模式找路径、\`grep\` 搜内容，均不走 bash 沙箱、不触发提权审批。`,
    `被拒命令: ${cmd}`,
  ].join(" ");
}

export function apply(ctx) {
  const logger = ctx?.logger?.warn?.bind(ctx.logger) ?? (() => {});
  ctx?.tools?.guard?.((exec) => {
    const reason = denyReason(exec?.name, exec?.arguments);
    if (reason) logger(`[read-query-guard] deny ${exec?.name}: ${reason}`);
    return reason;
  });
  return {};
}

export const inject = ["tools"];

export const name = "read-query-guard";

export default { apply, inject, name };
