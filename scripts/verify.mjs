/**
 * verify.mjs — 单次校验服务（CI / docker compose run --rm verify 调用）。
 *
 * 步骤：
 *   1) 运行有限域与窄义 BCH 纠错规则测试（test/run.js，子进程退出码即信号）
 *   2) 构建静态页面到 dist（scripts/build.mjs）
 *   3) 启动静态服务（临时端口，PORT=0）
 *   4) HTTP 冒烟：/healthz、/、静态资源，以及对“可纠正样例”走真实解码逻辑
 *   5) 无论成败关闭服务，以退出码结束（0 成功 / 非 0 失败）
 *
 * 说明：浏览器 Worker 无法在纯 Node 下驱动，因此“可纠正样例”的端到端纠错
 * 直接调用与 Worker 同源的 lib/bch.js（同一份代码、同一位序），并额外经 HTTP
 * 拉取 worker.js、lib/bch.js，确认它们作为页面资源可被浏览器加载。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { decodeBch, buildBch, systematicEncode } from '../src/lib/bch.js';
import { polyStringToBigInt } from '../src/lib/gf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function runStep(title, cmd, args, env = {}) {
  return new Promise((resolve) => {
    console.log(`\n=== ${title} ===`);
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, timeout: 4000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function waitForHealth(port, deadlineMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await httpGet(port, '/healthz');
      if (r.status === 200) return r;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw lastErr || new Error('health 等待超时');
}

async function main() {
  // ---------- 1) 有限域 + 纠错规则测试 ----------
  const testsOk = await runStep('步骤 1/4：有限域与 BCH 纠错规则测试', process.execPath, [
    path.join(root, 'test', 'run.js'),
  ]);
  check('测试套件退出码为 0', testsOk);

  // ---------- 2) 构建 ----------
  const buildOk = await runStep('步骤 2/4：构建静态页面', process.execPath, [
    path.join(root, 'scripts', 'build.mjs'),
  ]);
  check('构建退出码为 0', buildOk);

  // ---------- 3) 启动服务（临时端口） ----------
  console.log('\n=== 步骤 3/4：启动静态服务（临时端口） ===');
  const server = spawn(
    process.execPath,
    [path.join(root, 'scripts', 'serve.mjs')],
    {
      cwd: root,
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );

  let port = 0;
  server.stdout.on('data', (chunk) => {
    const m = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) port = Number(m[1]);
    process.stdout.write(chunk);
  });

  let serverExited = false;
  server.on('exit', (code) => {
    serverExited = true;
    if (code !== 0 && code !== null) {
      check(`服务进程非正常退出（code=${code}）`, false);
    }
  });

  // 等待端口就绪
  const portDeadline = Date.now() + 5000;
  while (!port && Date.now() < portDeadline && !serverExited) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check('服务已监听临时端口', port > 0, `port=${port}`);

  try {
    if (port > 0) {
      // ---------- 4) HTTP 冒烟 ----------
      console.log('\n=== 步骤 4/4：HTTP 冒烟 ===');

      const h = await waitForHealth(port, 5000);
      check('GET /healthz 200', h.status === 200, `status=${h.status}`);
      let healthJson = null;
      try {
        healthJson = JSON.parse(h.body);
      } catch { /* 下面检查会失败 */ }
      check('health JSON status=ok', healthJson && healthJson.status === 'ok', h.body);

      const home = await httpGet(port, '/');
      check('GET / 200', home.status === 200, `status=${home.status}`);
      check('首页含挂载点与 module 入口',
        home.body.includes('id="decode-form"') && home.body.includes('./app.js'));

      const workerRes = await httpGet(port, '/worker.js');
      check('GET /worker.js 200 且为 JS',
        workerRes.status === 200 &&
        (workerRes.headers['content-type'] || '').includes('javascript'),
        `status=${workerRes.status}`);
      check('worker.js 引入同源 BCH 库',
        workerRes.body.includes("from './lib/bch.js'"));

      const libRes = await httpGet(port, '/lib/bch.js');
      check('GET /lib/bch.js 200', libRes.status === 200, `status=${libRes.status}`);

      const cssRes = await httpGet(port, '/styles.css');
      check('GET /styles.css 200', cssRes.status === 200);

      // 安全：路径穿越应被拒绝
      const trav = await httpGet(port, '/..%2f..%2fpackage.json').catch(() => null);
      check('路径穿越被拒绝（非 200）', !trav || trav.status !== 200,
        trav ? `status=${trav.status}` : 'request-error');

      // 未知路由 404 JSON
      const nf = await httpGet(port, '/does-not-exist');
      check('未知路由 404', nf.status === 404, `status=${nf.status}`);

      // ---------- 可纠正样例：同源解码逻辑端到端 ----------
      console.log('\n=== 可纠正样例端到端（与 Worker 同源 lib） ===');
      const m = 7;
      const ps = '10010001'; // x^7+x^3+1，本原
      const t = 2;
      const built = buildBch(m, polyStringToBigInt(ps), t);
      check('样例 BCH(127,113) 构造成功', built.ok, built.reason);

      // 固定信息位，注入 2 个错误（确定性，不依赖随机）
      const info = new Array(built.k).fill(0);
      for (let i = 0; i < built.k; i += 3) info[i] = 1;
      const codeword = systematicEncode(info, built.generator, built.n, built.k);
      const flipped = [17, 90];
      const received = codeword.slice();
      for (const p of flipped) received[p] ^= 1;

      const result = decodeBch({
        m,
        polyStr: ps,
        t,
        wordStr: received.join(''),
      });
      check('可纠正样例判定 ok=true', result.ok, result.ok ? '' : result.reason);
      if (result.ok) {
        const ev = result.evidence;
        check('样例码长 n=127', ev.n === 127);
        check('样例信息位 k=113', ev.k === 113, `k=${ev.k}`);
        check('定位到恰好 2 个错误', ev.errorCount === 2, `count=${ev.errorCount}`);
        check('错误位置精确为 [17,90]',
          JSON.stringify(ev.roots.map((r) => r.position).sort((a, b) => a - b)) ===
            JSON.stringify(flipped));
        check('纠正后码字 == 原系统码字', ev.corrected === codeword.join(''));
        check('返回了生成多项式/综合症/σ/根等完整证据',
          !!ev.generatorBits && ev.syndromes.length === 4 &&
          Array.isArray(ev.roots) && ev.sigma.length >= 1);
      }

      // 反例：非法输入必须失败（确保冒烟同时覆盖失败路径）
      const bad = decodeBch({ m, polyStr: ps, t, wordStr: '0'.repeat(126) });
      check('长度不足的码字被判失败且无证据',
        !bad.ok && bad.stage === 'input' && bad.evidence === undefined, JSON.stringify(bad));
    }
  } finally {
    if (!serverExited) {
      server.kill('SIGTERM');
      await once(server, 'exit').catch(() => {});
    }
  }

  console.log(`\n========================================`);
  if (failures === 0 && testsOk && buildOk) {
    console.log('VERIFY 通过：有限域/BCH 规则、构建、健康与可纠正样例冒烟全部成功。');
    process.exit(0);
  } else {
    console.error(`VERIFY 失败：${failures} 个冒烟检查未通过（tests=${testsOk}, build=${buildOk}）。`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('VERIFY 异常终止：', e);
  process.exit(1);
});
