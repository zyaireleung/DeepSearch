import fs from "node:fs";

/**
 * Load a frozen query lexicon (shape-example word list).
 * Returns { version, entries, byText } where entries are frozen.
 */
export function loadQueryLexicon(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!raw.version || !Array.isArray(raw.entries)) {
    throw new Error("query lexicon must have version + entries[]");
  }
  const entries = raw.entries.map((e) => Object.freeze({ ...e }));
  const byText = new Map();
  for (const e of entries) byText.set(e.text, e);
  return Object.freeze({ version: raw.version, entries: Object.freeze(entries), byText });
}
