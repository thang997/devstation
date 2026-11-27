/** Ngôn ngữ của Editor: đoán theo đuôi file / nội dung, tải lười gói tô màu (mỗi ngôn ngữ một chunk). */
import type { Extension } from "@codemirror/state";

export type LangId =
  | "text" | "json" | "xml" | "html" | "javascript" | "typescript" | "css" | "sql" | "yaml" | "markdown"
  | "python" | "java" | "csharp" | "cpp" | "go" | "rust" | "php" | "shell" | "powershell" | "properties" | "dockerfile";

export const LANGS: { id: LangId; label: string }[] = [
  { id: "text", label: "Plain text" },
  { id: "json", label: "JSON" },
  { id: "xml", label: "XML" },
  { id: "html", label: "HTML" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "css", label: "CSS" },
  { id: "sql", label: "SQL" },
  { id: "yaml", label: "YAML" },
  { id: "markdown", label: "Markdown" },
  { id: "python", label: "Python" },
  { id: "java", label: "Java" },
  { id: "csharp", label: "C#" },
  { id: "cpp", label: "C / C++" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "php", label: "PHP" },
  { id: "shell", label: "Shell" },
  { id: "powershell", label: "PowerShell" },
  { id: "properties", label: "INI / Properties / .env" },
  { id: "dockerfile", label: "Dockerfile" },
];
export const langLabel = (id: LangId) => LANGS.find((l) => l.id === id)?.label ?? id;

const BY_EXT: Record<string, LangId> = {
  json: "json", jsonc: "json", json5: "json", har: "json", ipynb: "json", babelrc: "json", eslintrc: "json",
  xml: "xml", xsd: "xml", xsl: "xml", xslt: "xml", wsdl: "xml", svg: "xml", plist: "xml", config: "xml", csproj: "xml",
  pom: "xml", xaml: "xml", resx: "xml", props: "xml", targets: "xml", kml: "xml", rss: "xml", atom: "xml",
  html: "html", htm: "html", xhtml: "html", vue: "html",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  css: "css", scss: "css", less: "css",
  sql: "sql", ddl: "sql", cql: "sql",
  yml: "yaml", yaml: "yaml",
  md: "markdown", markdown: "markdown",
  py: "python", pyw: "python",
  java: "java", kt: "java", kts: "java", gradle: "java", scala: "java",
  cs: "csharp",
  c: "cpp", h: "cpp", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  go: "go",
  rs: "rust",
  php: "php",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  ini: "properties", cfg: "properties", conf: "properties", properties: "properties", env: "properties", toml: "properties",
  editorconfig: "properties", gitconfig: "properties", npmrc: "properties",
};
const BY_NAME: Record<string, LangId> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", ".env": "properties", ".gitignore": "properties",
  ".dockerignore": "properties", makefile: "shell", ".bashrc": "shell", ".zshrc": "shell", ".profile": "shell",
};

/** Đoán ngôn ngữ theo tên file; không ra thì theo nội dung đầu file. */
export function detectLang(name: string, text: string): LangId {
  const base = name.replace(/^.*[\\/]/, "").toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  if (base.startsWith("dockerfile")) return "dockerfile";
  if (base.startsWith(".env")) return "properties";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  return sniffLang(text);
}

/** Đoán theo nội dung (file không đuôi / tab mới dán vào). */
export function sniffLang(text: string): LangId {
  const t = text.slice(0, 2000).trimStart();
  if (!t) return "text";
  if (t.startsWith("{") || t.startsWith("[")) {
    try { JSON.parse(text); return "json"; } catch { /* không phải JSON hợp lệ */ }
    if (/^[[{]\s*["}\]]/.test(t)) return "json";
  }
  if (t.startsWith("<?xml") || /^<([A-Za-z_][\w.:-]*)[\s>][\s\S]*<\/\1>\s*$/.test(t.slice(0, 2000)) && !/^<!doctype html|^<html/i.test(t)) return "xml";
  if (/^<!doctype html|^<html/i.test(t)) return "html";
  if (t.startsWith("#!")) return /pwsh|powershell/.test(t.split("\n")[0]) ? "powershell" : /python/.test(t.split("\n")[0]) ? "python" : "shell";
  if (/^(select|insert|update|delete|create|alter|drop|with)\s/i.test(t)) return "sql";
  if (/^---\s*$/m.test(t.split("\n")[0]) || /^[\w-]+:\s.+\n[\w-]+:\s/m.test(t)) return "yaml";
  return "text";
}

/** Tải gói tô màu của ngôn ngữ (lười). */
export async function loadLang(id: LangId): Promise<Extension> {
  const legacy = async (pick: (m: Record<string, unknown>) => unknown, mod: () => Promise<Record<string, unknown>>) => {
    const { StreamLanguage } = await import("@codemirror/language");
    return StreamLanguage.define((pick(await mod())) as never);
  };
  switch (id) {
    case "json": return (await import("@codemirror/lang-json")).json();
    case "xml": return (await import("@codemirror/lang-xml")).xml();
    case "html": return (await import("@codemirror/lang-html")).html();
    case "javascript": return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript": return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "css": return (await import("@codemirror/lang-css")).css();
    case "sql": return (await import("@codemirror/lang-sql")).sql();
    case "yaml": return (await import("@codemirror/lang-yaml")).yaml();
    case "markdown": return (await import("@codemirror/lang-markdown")).markdown();
    case "python": return (await import("@codemirror/lang-python")).python();
    case "java": return (await import("@codemirror/lang-java")).java();
    case "cpp": return (await import("@codemirror/lang-cpp")).cpp();
    case "rust": return (await import("@codemirror/lang-rust")).rust();
    case "php": return (await import("@codemirror/lang-php")).php();
    case "csharp": return legacy((m) => m.csharp, () => import("@codemirror/legacy-modes/mode/clike"));
    case "go": return legacy((m) => m.go, () => import("@codemirror/legacy-modes/mode/go"));
    case "shell": return legacy((m) => m.shell, () => import("@codemirror/legacy-modes/mode/shell"));
    case "powershell": return legacy((m) => m.powerShell, () => import("@codemirror/legacy-modes/mode/powershell"));
    case "properties": return legacy((m) => m.properties, () => import("@codemirror/legacy-modes/mode/properties"));
    case "dockerfile": return legacy((m) => m.dockerFile, () => import("@codemirror/legacy-modes/mode/dockerfile"));
    default: return [];
  }
}
