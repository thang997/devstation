#!/usr/bin/env node
/**
 * Phát hành bản mới cho tính năng tự cập nhật (tauri-plugin-updater + GitHub Releases).
 *
 *   1. Tăng "version" trong src-tauri/tauri.conf.json (và package.json cho khớp).
 *   2. npm run release -- --notes "Nội dung thay đổi"
 *
 * Script: build có ký (private key ở ~/.tauri/devstation.key, KHÔNG nằm trong repo)
 *   → gom bộ cài + latest.json vào release/v<version>/
 *   → nếu có biến môi trường GITHUB_TOKEN thì tạo Release tag v<version> trên GitHub và upload luôn;
 *     không có thì in hướng dẫn upload tay.
 * App đã cài đọc https://github.com/<repo>/releases/latest/download/latest.json khi mở.
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = "thang997/devstation";
const root = resolve(import.meta.dirname, "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = `v${version}`;

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const notes = flag("--notes") ?? `DevStation ${tag}`;
const skipBuild = argv.includes("--skip-build");

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), ".tauri", "devstation.key");
if (!existsSync(keyPath)) {
  console.error(`✗ Không thấy private key ký update: ${keyPath}`);
  process.exit(1);
}

// 1. Build (ký bằng private key → sinh *.sig cạnh bộ cài).
if (!skipBuild) {
  console.log(`▶ Build ${tag} …`);
  execSync("npx tauri build", {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    },
  });
}

// 2. Tìm bộ cài NSIS + chữ ký của đúng version.
const nsisDir = join(root, "src-tauri/target/release/bundle/nsis");
const setup = readdirSync(nsisDir).find((f) => f.endsWith("-setup.exe") && f.includes(`_${version}_`));
if (!setup || !existsSync(join(nsisDir, `${setup}.sig`))) {
  console.error(`✗ Không thấy bộ cài/chữ ký cho ${version} trong ${nsisDir} (đã tăng version và build có ký chưa?)`);
  process.exit(1);
}
const signature = readFileSync(join(nsisDir, `${setup}.sig`), "utf8").trim();

// 3. latest.json — định dạng tĩnh của tauri-plugin-updater.
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${REPO}/releases/download/${tag}/${setup}`,
    },
  },
};

const outDir = join(root, "release", tag);
mkdirSync(outDir, { recursive: true });
copyFileSync(join(nsisDir, setup), join(outDir, setup));
writeFileSync(join(outDir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(`✓ Đã gom vào ${outDir}:\n   - ${setup}\n   - latest.json`);

// 4. Upload lên GitHub Releases (token quyền "Contents: Read and write" trên repo).
//    Lấy từ biến GITHUB_TOKEN, hoặc file ~/.tauri/github-token (ngoài repo, KHÔNG commit).
const tokenFile = join(homedir(), ".tauri", "github-token");
const token = process.env.GITHUB_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
if (!token) {
  console.log(`
Chưa có token (GITHUB_TOKEN hoặc ~/.tauri/github-token) → upload tay:
  1. Mở https://github.com/${REPO}/releases/new
  2. Tag: ${tag}  (target: main)  — KHÔNG tick "pre-release"
  3. Kéo thả 2 file trong ${outDir} vào phần Assets → Publish release.
Các máy đã cài sẽ thấy bản mới ở lần mở app kế tiếp.`);
  process.exit(0);
}

const gh = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}\n${text}`);
  return text ? JSON.parse(text) : null;
};

console.log(`▶ Tạo GitHub Release ${tag} …`);
const rel = await gh(`https://api.github.com/repos/${REPO}/releases`, {
  method: "POST",
  body: JSON.stringify({ tag_name: tag, target_commitish: "main", name: `DevStation ${tag}`, body: notes, draft: false, prerelease: false }),
});
const uploadBase = rel.upload_url.replace(/\{.*\}$/, "");
for (const [name, type] of [[setup, "application/octet-stream"], ["latest.json", "application/json"]]) {
  console.log(`  ↑ ${name}`);
  await gh(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": type },
    body: readFileSync(join(outDir, name)),
  });
}
console.log(`✓ Đã phát hành: ${rel.html_url}`);
