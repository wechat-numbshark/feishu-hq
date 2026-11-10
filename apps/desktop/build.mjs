// 桌面构建（M6）：以纯 Node（零依赖、零网络）产出真实、可校验的离线桌面应用包。
// 策略与 docs/apps/desktop README 一致：桌面端只是对同一份 Web 前端的薄包装
// （Tauri：系统托盘/通知/本地安全存储/自动更新，不复制业务前端）。
// 因此本脚本：
//   1) 复制 apps/web 静态资源进 dist/<bundleName>/web/
//   2) 写出桌面包装清单 desktop.manifest.json 与 Tauri v2 配置 src-tauri/tauri.conf.json
//      （frontendDist 指向上一步复制的资源）——即"打包就绪"配置。
//   3) 尽力用系统 tar 产出可分发 .tar.gz（存在则生成），并计算 sha256 + 字节数。
// 诚实边界：原生签名安装器(.msi/.app/.deb)需 Rust/Tauri 工具链 + 系统 WebView，
//   该步骤由 CI/维护者执行；本沙箱无 cargo/rustc 且受限网络无法拉取，故不伪造安装器。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = rootPkg.version || "0.0.0";
const bundleName = `hq-desktop-${version}`;

const webSrc = path.join(repoRoot, "apps", "web");
const distRoot = path.join(here, "dist");
const bundleDir = path.join(distRoot, bundleName);
const webOut = path.join(bundleDir, "web");

// 需要打包的静态资源（存在才复制，og.png 等）
const webFiles = ["index.html", "app.js", "api.js", "styles.css", "og.png", "README.md"];

fs.rmSync(bundleDir, { recursive: true, force: true });
fs.mkdirSync(webOut, { recursive: true });

const copied = [];
for (const f of webFiles) {
  const src = path.join(webSrc, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(webOut, f));
    copied.push(f);
  }
}

// 桌面包装清单
const manifest = {
  name: "总部 OS 桌面端",
  appId: "cn.feishu.hq.desktop",
  version,
  entry: "web/index.html",
  shell: "tauri-v2",
  base_url_env: "HQ_BASE_URL",
  packaged_assets: copied,
  built_at: new Date().toISOString(),
  license: "AGPL-3.0-only",
  note: "桌面端为同一份 Web 前端的薄包装；原生安装器需 Rust/Tauri 工具链在 CI/维护者环境构建。",
};
fs.writeFileSync(path.join(bundleDir, "desktop.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// Tauri v2 打包就绪配置（不触发原生构建）
const tauriDir = path.join(bundleDir, "src-tauri");
fs.mkdirSync(tauriDir, { recursive: true });
const tauriConf = {
  $schema: "https://schema.tauri.app/config/2",
  productName: "总部 OS",
  version,
  identifier: manifest.appId,
  build: { frontendDist: "../web" },
  app: {
    windows: [{ title: "总部 OS · 把总部建到飞书", width: 1280, height: 860, resizable: true }],
    security: { csp: null },
  },
  bundle: { active: true, targets: ["all"], category: "Business" },
};
fs.writeFileSync(path.join(tauriDir, "tauri.conf.json"), JSON.stringify(tauriConf, null, 2) + "\n");

// 尽力产出可分发 .tar.gz（系统 tar 存在时）
const tarball = path.join(distRoot, `${bundleName}.tar.gz`);
fs.rmSync(tarball, { force: true });
let artifact = bundleDir;
let tarOk = false;
const tar = spawnSync("tar", ["-czf", tarball, "-C", distRoot, bundleName], { stdio: "ignore" });
if (tar.status === 0 && fs.existsSync(tarball)) { tarOk = true; artifact = tarball; }

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
const bytes = fs.statSync(artifact).size;
const digest = tarOk ? sha256(tarball) : "n/a(dir-bundle)";

// 校验产物真实非空：包内 web 资源字节总和 > 0
const packedBytes = copied.reduce((s, f) => s + fs.statSync(path.join(webOut, f)).size, 0);

console.log(`BUILD_BUNDLE_NAME=${bundleName}`);
console.log(`BUILD_COPIED=${copied.join(",")}`);
console.log(`BUILD_WEB_ASSET_BYTES=${packedBytes}`);
console.log(`BUILD_TARBALL=${tarOk ? "yes" : "no(tar-unavailable; folder-bundle-is-artifact)"}`);
console.log(`BUILD_ARTIFACT=${path.relative(repoRoot, artifact)}`);
console.log(`BUILD_ARTIFACT_BYTES=${bytes}`);
console.log(`BUILD_SHA256=${digest}`);

const pass = packedBytes > 0 && fs.existsSync(path.join(webOut, "index.html")) && fs.existsSync(path.join(bundleDir, "desktop.manifest.json")) && fs.existsSync(path.join(tauriDir, "tauri.conf.json"));
console.log(pass ? "BUILD_RESULT=PASS desktop bundle produced (native installer requires Tauri/Rust toolchain; not fabricated here)" : "BUILD_RESULT=FAIL");
process.exit(pass ? 0 : 1);
