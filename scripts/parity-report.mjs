import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "docs/parity");
const argumentsList = process.argv.slice(2);
const options = { check: false };
for (let index = 0; index < argumentsList.length; index++) {
  const option = argumentsList[index];
  if (option === "--check") {
    options.check = true;
    continue;
  }
  assert.ok(["--results", "--checks", "--output"].includes(option), `Unknown option: ${option}`);
  const value = argumentsList[++index];
  assert.ok(value && !value.startsWith("--"), `Missing value for ${option}`);
  options[option.slice(2)] = path.resolve(value);
}
const local = Boolean(options.results || options.checks || options.output);
if (local) {
  assert.ok(options.results && options.checks && options.output, "Local report requires --results, --checks and --output");
  assert.notEqual(options.output, path.join(directory, "README.md"), "Local observations must not overwrite public test specification");
}
const output = options.output ?? path.join(directory, "README.md");
const manifest = JSON.parse(await readFile(path.join(directory, "cases.json"), "utf8"));
const observations = local ? JSON.parse(await readFile(options.results, "utf8")) : [];
const checks = local ? JSON.parse(await readFile(options.checks, "utf8")) : [];
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const stringList = (value, label) => {
  assert.ok(Array.isArray(value) && value.length > 0 && value.every(nonempty), `${label}: expected nonempty string list`);
};
const sourceRepos = {
  core: "modelzen/feishu-codex-bridge",
  desktop: "modelzen/vonvon-bot",
  legacy: "modelzen/vonvon-bridge-legacy",
};
const sourcePattern = /^(core|desktop|legacy)@([\w.-]+):([\w./-]+)$/;
function source(sourceRef, label) {
  assert.ok(sourceRef && typeof sourceRef === "object", `${label}: invalid source reference`);
  const match = sourcePattern.exec(sourceRef.path);
  assert.ok(match && !match[3].split("/").includes("..") && !match[3].startsWith("/"), `${label}: invalid revision-qualified path`);
  assert.ok(Number.isSafeInteger(sourceRef.line) && sourceRef.line > 0, `${label}: invalid line`);
  assert.ok(nonempty(sourceRef.symbol), `${label}: missing source location`);
  return `[${match[1]}@${match[2]}:${match[3]}:${sourceRef.line}](https://github.com/${sourceRepos[match[1]]}/blob/${match[2]}/${match[3]}#L${sourceRef.line})。${sourceRef.symbol}`;
}
assert.ok(manifest && nonempty(manifest.scope) && Array.isArray(manifest.cases), "Invalid case manifest");
assert.ok(manifest.baseline && typeof manifest.baseline === "object", "Missing baselines");
assert.ok(Array.isArray(observations) && Array.isArray(checks), "Invalid local observation files");
const ids = new Set();
for (const item of manifest.cases) {
  assert.ok(/^([A-Z]+)-\d{3}$/.test(item.id) && !ids.has(item.id), `Duplicate or invalid case: ${item.id}`);
  ids.add(item.id);
  for (const key of ["title", "area"]) assert.ok(nonempty(item[key]), `${item.id}: missing ${key}`);
  for (const key of ["preconditions", "steps", "expected", "cleanup"]) stringList(item[key], `${item.id}.${key}`);
  stringList(item.baselineEvidence?.map(value => value.symbol), `${item.id}.baselineEvidence`);
  for (const [index, value] of item.baselineEvidence.entries()) source(value, `${item.id}.baselineEvidence[${index}]`);
  for (const [index, value] of (item.desktopEvidence ?? []).entries()) source(value, `${item.id}.desktopEvidence[${index}]`);
  assert.ok(["present", "partial", "missing"].includes(item.coverage), `${item.id}: invalid source coverage`);
  assert.ok(["native", "integration", "external"].includes(item.verification), `${item.id}: invalid verification`);
}
const states = { PASS: "通过", FAIL: "失败", BLOCKED: "受阻", NOT_RUN: "待测" };
const verificationNames = { native: "桌面实际操作", integration: "集成测试", external: "外部服务验证" };
const checkedIds = new Set();
for (const item of checks) {
  assert.ok(ids.has(item.id) && !checkedIds.has(item.id), `Unknown or duplicate checked case: ${item.id}`);
  checkedIds.add(item.id);
  assert.ok(Array.isArray(item.checks) && item.checks.length > 0, `${item.id}: missing partial checks`);
  for (const check of item.checks) {
    assert.ok(nonempty(check.name) && nonempty(check.result) && nonempty(check.evidence), `${item.id}: incomplete partial check`);
  }
  stringList(item.remaining, `${item.id}.remaining`);
}
const latest = new Map();
for (const result of observations) {
  assert.ok(ids.has(result.id), `Unknown case: ${result.id}`);
  assert.ok(["macos", "windows"].includes(result.platform), `Invalid platform: ${result.platform}`);
  assert.ok(Object.hasOwn(states, result.status), `Invalid result: ${result.status}`);
  assert.ok(nonempty(result.observedAt) && !Number.isNaN(Date.parse(result.observedAt)), `${result.id}: invalid time`);
  assert.ok(nonempty(result.actual), `${result.id}: missing observed outcome`);
  stringList(result.evidence, `${result.id}.evidence`);
  assert.ok(["native", "integration", "external", "static"].includes(result.level), `${result.id}: invalid verification level`);
  assert.ok(nonempty(result.desktopRevision), `${result.id}: missing revision`);
  assert.equal(typeof result.complete, "boolean", `${result.id}: missing completion flag`);
  if (result.status === "PASS") {
    assert.equal(result.complete, true, `${result.id}: partial checks cannot pass a complete case`);
    assert.notEqual(result.level, "static", `${result.id}: source inspection cannot pass`);
  }
  latest.set(`${result.id}:${result.platform}`, result);
}
const totals = Object.fromEntries(Object.keys(states).map(key => [key, 0]));
if (local) for (const item of manifest.cases) {
  for (const platform of ["macos", "windows"]) totals[latest.get(`${item.id}:${platform}`)?.status ?? "NOT_RUN"]++;
}
const escape = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const lines = [
  local ? "# 桌面版功能覆盖与本地测试记录" : "# 桌面版功能覆盖测试用例",
  "",
  manifest.scope,
  "",
  `共 ${manifest.cases.length} 条用例。每条分别在 macOS 和 Windows 验证。`,
  "",
  "源码位置用于确认基线和查找实现，不代表整条用例通过。定位说明可以是代码符号或附近行为的描述。完成操作步骤、核对预期并保存证据后，才能记录平台测试结果。",
  "",
];
if (!local) lines.push(
  "本页只含可公开的测试规格。运行 `node scripts/parity-report.mjs --check` 检查它是否与 cases.json 同步。执行记录另行保存在本机忽略目录，用 `--results <观察文件> --checks <分项文件> --output <本地报告路径>` 生成；执行结果不会进入本页。",
  "",
);
if (local) lines.push(
  `本地观察汇总。通过 ${totals.PASS}，失败 ${totals.FAIL}，受阻 ${totals.BLOCKED}，待测 ${totals.NOT_RUN}。另有 ${checks.length} 条用例有分项检查记录，分项结果不计为整条通过。`,
  "",
  "本报告含本机执行证据。请保存在忽略目录中，不要提交真实群名、设备路径、聊天记录或临时文件路径。历史失败记录保留在输入观察文件内，表格展示每个平台最后一次观察。",
  "",
);
lines.push("## 基线", "", ...Object.entries(manifest.baseline).map(([key, value]) => `- ${key}。${value}`), "", "## 覆盖表", "");
if (local) lines.push("| 编号 | 功能或设置 | macOS | Windows |", "| --- | --- | --- | --- |",
  ...manifest.cases.map(item => `| [${item.id}](#${item.id.toLowerCase()}) | ${escape(item.title)} | ${states[latest.get(`${item.id}:macos`)?.status ?? "NOT_RUN"]} | ${states[latest.get(`${item.id}:windows`)?.status ?? "NOT_RUN"]} |`));
else lines.push("| 编号 | 功能或设置 | 验证方式 |", "| --- | --- | --- |",
  ...manifest.cases.map(item => `| [${item.id}](#${item.id.toLowerCase()}) | ${escape(item.title)} | ${verificationNames[item.verification]} |`));
for (const item of manifest.cases) {
  lines.push("", `## ${item.id}`, "", item.title, "", `类别。${item.area}`, "");
  for (const [key, label] of [["preconditions", "前置条件"], ["steps", "操作步骤"], ["expected", "预期结果"], ["cleanup", "恢复步骤"]]) {
    lines.push(`**${label}**`, "", ...item[key].map((value, index) => `${index + 1}. ${value}`), "");
  }
  lines.push("**原功能依据**", "", ...item.baselineEvidence.map(value => `- ${source(value, item.id)}`), "");
  if (item.desktopEvidence?.length) lines.push("**桌面源码核对位置**", "", ...item.desktopEvidence.map(value => `- ${source(value, item.id)}`), "");
  if (local) {
    const partial = checks.find(check => check.id === item.id);
    if (partial) lines.push("**已执行的分项检查**", "", ...partial.checks.map(check => `- ${check.result}。${check.name} 证据 ${check.evidence}。`), "", "**仍需验证**", "", ...partial.remaining.map(value => `- ${value}`), "");
    for (const platform of ["macos", "windows"]) {
      const result = latest.get(`${item.id}:${platform}`);
      lines.push(`**${platform}。${states[result?.status ?? "NOT_RUN"]}**`, "");
      if (result) lines.push(`${result.actual} 验证层级为 ${result.level}，版本为 ${result.desktopRevision}，时间为 ${result.observedAt}。`, "", ...result.evidence.map(value => `- ${value}`), "");
    }
  }
}
if (manifest.scopeNotes?.length) {
  lines.push("", "## 单列的范围说明", "");
  for (const item of manifest.scopeNotes) {
    assert.ok(nonempty(item.id) && nonempty(item.decision) && nonempty(item.reason), "Invalid scope note");
    const references = item.case?.baselineEvidence ?? [];
    for (const reference of references) source(reference, item.id);
    lines.push(`- ${item.id}。${item.decision}。${item.reason}${references.length ? ` 依据 ${references.map(reference => source(reference, item.id)).join("；")}。` : ""}`);
  }
}
if (manifest.exclusions?.length) {
  lines.push("", "## 不单独提供桌面入口的内部机制", "");
  for (const item of manifest.exclusions) {
    assert.ok(nonempty(item.capability) && nonempty(item.reason) && Array.isArray(item.evidence), "Invalid exclusion");
    lines.push(`- ${item.capability}。${item.reason} 依据 ${item.evidence.map(value => source(value, item.capability)).join("；")}。`);
  }
}
const generated = `${lines.join("\n")}\n`;
if (options.check) assert.ok((await readFile(output, "utf8")) === generated, `${output} is stale; regenerate it`);
else await writeFile(output, generated);
process.stdout.write(`${JSON.stringify({ cases: ids.size, observations: observations.length, totals, output, checked: options.check })}\n`);
