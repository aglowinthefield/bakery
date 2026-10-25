import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, grammar] of Object.entries({ bash, css, javascript, json, markdown, typescript, xml, yaml })) hljs.registerLanguage(name, grammar);

const languages: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  css: "css", scss: "css", json: "json", md: "markdown", mdx: "markdown", html: "xml", svg: "xml", xml: "xml",
  sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml",
};
export function languageForPath(path: string): string | null {
  return languages[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? null;
}

function escapeHtml(code: string): string {
  return code.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
export function highlightDiffCode(code: string, path: string): string {
  const language = languageForPath(path);
  return language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code);
}
