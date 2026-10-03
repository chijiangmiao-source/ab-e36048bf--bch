/**
 * app.js — 页面主线程：表单、Worker 通信、结果渲染。
 * 不做任何有限域计算，全部交给 worker.js（与 Node 测试同源）。
 */

const $ = (id) => document.getElementById(id);

const form = $('decode-form');
const inputM = $('input-m');
const inputT = $('input-t');
const inputPoly = $('input-poly');
const inputWord = $('input-word');
const expectedN = $('expected-n');
const wordLengthInfo = $('word-length-info');
const resultBox = $('result');
const workerStatus = $('worker-status');
const btnVerify = $('btn-verify');
const btnClear = $('btn-clear');

let worker = null;
let nextId = 1;
const pending = new Map();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&amp;quot;';
      default: return '&#39;';
    }
  });
}

function currentN() {
  const m = Number(inputM.value);
  if (Number.isInteger(m) && m >= 2 && m <= 16) return 2 ** m - 1;
  return null;
}

function refreshWordInfo() {
  const n = currentN();
  const len = inputWord.value.trim().length;
  if (n != null) expectedN.textContent = String(n);
  wordLengthInfo.textContent = `当前长度：${len}`;
}

function spawnWorker() {
  if (worker) return worker;
  try {
    worker = new Worker('./worker.js', { type: 'module' });
  } catch (e) {
    workerStatus.textContent = 'Worker 初始化失败，页面无法进行离线计算';
    workerStatus.className = 'worker-status bad';
    return null;
  }
  worker.onmessage = (ev) => {
    const { id, result } = ev.data;
    const resolvers = pending.get(id);
    if (resolvers) {
      pending.delete(id);
      resolvers.resolve(result);
    }
  };
  worker.onerror = (e) => {
    workerStatus.textContent = `Worker 错误：${e.message}`;
    workerStatus.className = 'worker-status bad';
  };
  return worker;
}

function decode(input) {
  const w = spawnWorker();
  if (!w) return Promise.reject(new Error('worker-unavailable'));
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    w.postMessage({ type: 'decode', id, input });
  });
}

function collectInput() {
  return {
    m: Number(inputM.value),
    polyStr: inputPoly.value,
    t: Number(inputT.value),
    wordStr: inputWord.value.trim(),
  };
}

/** 渲染成功证据；所有证据来自同一次成功的 decodeBch，不与旧结论混用。 */
function renderSuccess(ev) {
  const positions = new Set(ev.roots.map((r) => r.position));
  const highlight = (wordStr) =>
    Array.from(wordStr, (ch, i) =>
      positions.has(i) ? `<span class="err">${ch}</span>` : ch,
    ).join('');

  const syndromeRows = ev.syndromes
    .map((s) => {
      const cls = s.kind === 'zero' ? 'good chip' : 'chip';
      return `<tr><td class="mono">S<sub>${s.j}</sub></td>
        <td class="mono">${escapeHtml(s.text)}</td>
        <td><span class="${cls}">${s.kind === 'zero' ? '零' : '非零'}</span></td></tr>`;
    })
    .join('');

  const sigmaChips = ev.sigma
    .map((c) => {
      const label = c.power === 0 ? 'σ₀' : `σ${subscript(c.power)}`;
      return `<span class="chip">${label} = ${escapeHtml(c.text)}</span>`;
    })
    .join('');

  const rootRows = ev.roots
    .sort((a, b) => a.position - b.position)
    .map((r) => `<tr>
      <td class="mono">${r.position}</td>
      <td class="mono">${r.oneBased}</td>
      <td class="mono">${escapeHtml(r.root.text)}</td>
    </tr>`)
    .join('');

  const cosetChips = ev.cosets
    .map((c) => `<span class="chip">{${c.join(', ')}}</span>`)
    .join('');

  resultBox.className = 'card result-card ok';
  resultBox.hidden = false;
  resultBox.innerHTML = `
    <div class="banner ok">
      <span>✓ 可纠正（窄义 BCH (n=${ev.n}, k=${ev.k}, d≥${2 * ev.t + 1})，共 ${
        ev.errorCount
      } 处错误${ev.noError ? '；接收字本身就是有效码字（无错误）' : ''}）</span>
    </div>

    <div class="evidence-block">
      <h3>① 本原多项式与码参数</h3>
      <div class="val">m = ${ev.m}，t = ${ev.t}，n = 2^m−1 = ${ev.n}，k = n−deg g = ${ev.k}
p(x) 比特串（x⁰ 在串首）：${escapeHtml(ev.primitiveBits)}</div>
    </div>

    <div class="evidence-block">
      <h3>② 生成多项式 g(x)</h3>
      <div class="chips" style="margin-bottom:8px">${cosetChips}</div>
      <div class="val">deg g = ${ev.generatorDegree}
g(x) 比特串（x⁰ 在串首，长度 ${ev.generatorBits.length}）：
${escapeHtml(ev.generatorBits)}</div>
    </div>

    <div class="evidence-block">
      <h3>③ 综合症 S<sub>j</sub> = R(α<sub>j</sub>)，j=1..${2 * ev.t}</h3>
      <table class="tight">
        <thead><tr><th>综合症</th><th>值（GF(2^m)）</th><th>判定</th></tr></thead>
        <tbody>${syndromeRows}</tbody>
      </table>
    </div>

    <div class="evidence-block">
      <h3>④ 错误定位多项式 σ(x)（Berlekamp–Massey，deg σ = ${ev.sigmaDegree}）</h3>
      <div class="chips">${sigmaChips}</div>
    </div>

    <div class="evidence-block">
      <h3>⑤ Chien 搜索：σ(α^(−p)) = 0 对应的比特位置</h3>
      ${
        ev.roots.length === 0
          ? '<div class="val">无错误位置（定位多项式为常数 1）。</div>'
          : `<table class="tight">
              <thead><tr><th>位置 p（x^p，0 起）</th><th>第几位（1 起）</th><th>定位根</th></tr></thead>
              <tbody>${rootRows}</tbody>
            </table>`
      }
    </div>

    <div class="evidence-block">
      <h3>⑥ 纠正后码字（红底为翻转位，位序与输入一致）</h3>
      <div class="val wordgrid">接收：${highlight(ev.received)}
纠正：${escapeHtml(ev.corrected)}
位号：${Array.from({ length: ev.n }, (_, i) =>
        positions.has(i) ? '^' : ' ',
      ).join('')}</div>
    </div>

    <div class="evidence-block">
      <h3>闭合校验</h3>
      <div class="val">Chien 根数 ${ev.roots.length} = deg σ ${ev.sigmaDegree}；
纠正后重新计算 S₁…S₂ₜ 全部为零。证据闭合，结论成立。</div>
    </div>
  `;
}

function subscript(n) {
  return String(n).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]).join('');
}

const STAGE_LABELS = {
  input: '输入校验',
  primitive: '本原多项式验证',
  parameters: '参数组合',
  generator: '生成多项式',
  bm: 'Berlekamp–Massey',
  chien: 'Chien 搜索',
  verify: '纠正后复核',
  fatal: '未预期错误',
};

function renderFailure(reason, stage) {
  resultBox.className = 'card result-card fail';
  resultBox.hidden = false;
  // 失败时整块重写，旧成功证据（生成多项式/综合症/根等）随 innerHTML 一并清除
  resultBox.innerHTML = `
    <div class="banner fail">
      <span>✗ 无法给出可纠正结论</span>
      <span class="stage">失败阶段：${escapeHtml(STAGE_LABELS[stage] || stage)}</span>
    </div>
    <div class="evidence-block">
      <h3>失败原因</h3>
      <div class="val">${escapeHtml(reason)}</div>
    </div>
    <div class="evidence-block">
      <h3>旧证据状态</h3>
      <div class="val">本次失败不产生任何成功证据；页面上此前的生成多项式、综合症、定位根、纠正码字均已清除。</div>
    </div>
  `;
}

function clearAll() {
  form.reset();
  refreshWordInfo();
  resultBox.hidden = true;
  resultBox.innerHTML = '';
  resultBox.className = 'card result-card';
  workerStatus.textContent = '';
  workerStatus.className = 'worker-status';
  inputM.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btnVerify.disabled = true;
  workerStatus.textContent = 'Worker 正在离线复核…';
  workerStatus.className = 'worker-status busy';
  try {
    const result = await decode(collectInput());
    if (result.ok) {
      renderSuccess(result.evidence);
      workerStatus.textContent = '复核完成：证据闭合';
      workerStatus.className = 'worker-status ready';
    } else {
      renderFailure(result.reason, result.stage);
      workerStatus.textContent = '复核完成：判定失败';
      workerStatus.className = 'worker-status bad';
    }
  } catch (err) {
    renderFailure(
      'Worker 不可用，无法完成计算。请确认通过 HTTP 方式打开本页面（module worker 不支持 file://）。',
      'fatal',
    );
    workerStatus.textContent = 'Worker 不可用';
    workerStatus.className = 'worker-status bad';
  } finally {
    btnVerify.disabled = false;
  }
});

btnClear.addEventListener('click', clearAll);
inputM.addEventListener('input', refreshWordInfo);
inputWord.addEventListener('input', refreshWordInfo);
refreshWordInfo();
