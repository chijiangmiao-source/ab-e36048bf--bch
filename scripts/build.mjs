/**
 * build.mjs — 构建静态页面到 dist/。
 * 本项目前端全部为原生 ES Module（Worker 直接 import lib），无需打包器；
 * “构建”负责：必要文件校验 -> 清理旧 dist -> 拷贝 src -> 生成构建清单。
 * 退出码：成功 0，失败 1。
 */
import { rm, mkdir, cp, writeFile, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'src');
const DIST = path.join(root, 'dist');

const REQUIRED = [
  'index.html',
  'styles.css',
  'app.js',
  'worker.js',
  'lib/gf.js',
  'lib/bch.js',
];

async function exists(p) {
  try {
    await access(p, constants.R);
    return true;
  } catch {
    return false;
  }
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  // 1) 必要文件校验
  for (const rel of REQUIRED) {
    const p = path.join(SRC, rel);
    if (!(await exists(p))) {
      console.error(`[build] 缺少必要文件：src/${rel}`);
      process.exit(1);
    }
  }
  // index.html 必须引用 module worker 与同源 lib（结构性自检）
  const html = await readFile(path.join(SRC, 'index.html'), 'utf8');
  if (!html.includes('./app.js') || !html.includes('type="module"')) {
    console.error('[build] index.html 未正确挂载 module 入口');
    process.exit(1);
  }

  // 2) 清理旧 dist
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 3) 拷贝
  await cp(SRC, DIST, { recursive: true });
  console.log(`[build] 已拷贝 src -> dist`);

  // 4) 构建清单
  const manifest = {
    name: 'narrow-bch-verify',
    builtAt: new Date().toISOString(),
    git: gitSha(),
    files: REQUIRED,
  };
  await writeFile(path.join(DIST, 'build.json'), JSON.stringify(manifest, null, 2));
  console.log(`[build] 清单：${JSON.stringify({ git: manifest.git })}`);
  console.log('[build] 完成。');
}

main().catch((e) => {
  console.error('[build] 失败：', e);
  process.exit(1);
});
