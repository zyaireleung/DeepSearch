/**
 * 基于规则的局部语义关系裁判（离线逻辑层专用）。
 *
 * 确定性规则表：同义词传达概念（semantic）；scope 维度候选值冲突（conflict）。
 * 不接受 source/上游 score/全局分作为输入；只消费 unit × candidate 局部文本。
 *
 * 规则：
 *  1. semantic：unit.text 的别名同义词在文本中出现，且 unit.text 字面缺失 → semantic；
 *  2. conflict：unit.kind==="scope" 且文本含该 scope 维度的其他候选值同义词（如沙盒/测试环境），
 *     且 unit.value ≠ 候选 scope 值、unit 字面缺失 → conflict；
 *  3. 否则 missing。
 */

// 词表同义词：unit 文本 → 同义表达（传达同一概念，非字面）
export const SYNONYMS = {
  "生产": ["正式环境", "实际环境", "线上环境", "部署环境", "production环境"],
  "红线": ["底线", "界限", "禁区", "不可触碰", "严格禁止"],
  "沙盒": ["测试环境", "隔离环境", "镜像环境", "sandbox环境"],
  "规则": ["准则", "约束", "规范", "判据", "规定"],
  "部署": ["上线", "发布", "投放", "启用"],
  "验证": ["确认", "检查", "核实", "复验", "验收"],
  "备份": ["快照", "副本", "拷贝", "存档"],
  "恢复": ["回滚", "还原", "修复"],
  "同步": ["对齐", "拉齐", "镜像"],
  "失败": ["报错", "异常", "出错", "崩溃", "错误"],
  "记忆": ["recall", "上下文记忆", "场景记忆"],
  "蒸馏": ["提炼", "浓缩", "抽取", "提取"],
  "端口": ["监听地址", "服务地址", "host:port"],
  "进程": ["实例", "服务实例", "daemon"],
  "状态": ["进度", "阶段", "模式"],
};

// scope 维度候选值同义词：dimension → value → 同义词列表
const SCOPE_VALUE_SYNONYMS = {
  environment: {
    sandbox: ["沙盒", "测试环境", "隔离环境", "镜像环境", "sandbox环境"],
    production: ["生产", "正式环境", "实际环境", "线上环境", "部署环境", "production环境"],
  },
};

function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[\s,，。！？、；：""''（）()《》【】·\-_/\\]/g, "");
}

export function createRuleBasedSemanticRelation({ lexicon } = {}) {
  return async function ruleBasedSemanticRelation({ unit, text, exactEvidence }) {
    if (exactEvidence) return { state: "missing", evidence: "" };
    const nt = norm(text);
    if (!nt) return { state: "missing", evidence: "" };

    // 1) semantic：同义词存在且 unit 字面缺失
    const syns = SYNONYMS[unit.text] || [];
    for (const s of syns) {
      const ns = norm(s);
      if (ns && nt.includes(ns)) {
        return { state: "semantic", evidence: s, confidence: 0.9 };
      }
    }

    // 2) conflict：scope 维度，文本含其他候选值同义词，unit.value 不同
    if (unit.kind === "scope" && unit.dimension && unit.value) {
      const valueSyns = SCOPE_VALUE_SYNONYMS[unit.dimension] || {};
      for (const [value, words] of Object.entries(valueSyns)) {
        if (value === unit.value) continue; // 同值不算冲突
        for (const w of words) {
          const nw = norm(w);
          if (nw && nt.includes(nw)) {
            return {
              state: "conflict", evidence: w, confidence: 0.95,
              dimension: unit.dimension, candidateValue: value,
              relation: "scope-restricted-to-candidate-value",
            };
          }
        }
      }
    }

    return { state: "missing", evidence: "" };
  };
}
