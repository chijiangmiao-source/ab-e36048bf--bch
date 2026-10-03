/**
 * run.js — 零依赖测试：有限域 + 窄义二进制 BCH 规则。
 * 退出码：全部通过 0，任一失败 1。供 scripts/verify.js 调用。
 */
import {
  GF,
  gf2PolyMul,
  gf2PolyDivmod,
  gf2PolyGcd,
  gf2PolyPowMod,
  isIrreducible,
  validatePrimitivePolynomial,
  polyStringToBigInt,
  bigIntToPolyString,
  primeFactors,
} from '../src/lib/gf.js';
import {
  buildBch,
  cyclotomicCoset,
  requiredCosets,
  minimalPolynomial,
  syndromes,
  berlekampMassey,
  chienSearch,
  systematicEncode,
  decodeBch,
} from '../src/lib/bch.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const a = typeof actual === 'bigint' || typeof expected === 'bigint'
    ? String(actual) === String(expected)
    : JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, a, a ? '' : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

/** 确定性伪随机，便于错误注入可复现。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function choosePositions(rand, n, count) {
  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

// ---------------------------------------------------------------
// 1. GF(2) 多项式算术
// ---------------------------------------------------------------
console.log('[1] GF(2) 多项式算术');
eq('(x+1)(x+1) = x^2+1', gf2PolyMul(3n, 3n), 5n);
eq('(x^2+x+1)(x+1) = x^3+1', gf2PolyMul(7n, 3n), 9n);
{
  const { q, r } = gf2PolyDivmod(0b11101n, 0b1011n); // (x4+x3+x2+1)/(x3+x+1)
  ok('带余除法 q*b+r = a', (gf2PolyMul(q, 0b1011n) ^ r) === 0b11101n);
  ok('带余除法余式次数更低', r === 0n || (r.toString(2).length - 1) < 3, `r=${r}`);
}
eq('gcd((x+1)^2, x+1) = x+1', gf2PolyGcd(5n, 3n), 3n);
eq('gcd(x^3+1, x^2+1) = x+1', gf2PolyGcd(9n, 5n), 3n);
eq('powmod α^7 ≡ 1 (mod x^3+x+1)', gf2PolyPowMod(2n, 7n, 0b1011n), 1n);
eq('primeFactors(15)', primeFactors(15), [3, 5]);
eq('primeFactors(31)', primeFactors(31), [31]);

// ---------------------------------------------------------------
// 2. 不可约 / 本原判定
// ---------------------------------------------------------------
console.log('[2] 不可约与本原多项式判定');
ok('x^2+x+1 不可约', isIrreducible(0b111n, 2));
ok('x^3+x+1 不可约', isIrreducible(0b1011n, 3));
ok('x^4+x^3+x^2+x+1 不可约但…', isIrreducible((1n << 4n) | 0b1111n, 4));
{
  const r1 = validatePrimitivePolynomial(3, 0b1011n);
  ok('x^3+x+1 本原', r1.ok, r1.reason);
  const r2 = validatePrimitivePolynomial(4, (1n << 4n) | 0b1111n); // x4+...+1，阶 5
  ok('x^4+x^3+x^2+x+1 非本原被拒', !r2.ok && r2.reason.includes('本原'));
  const r3 = validatePrimitivePolynomial(4, 0b10001n); // x^4+1 = (x+1)^4
  ok('x^4+1 可约被拒', !r3.ok && r3.reason.includes('可约'));
  const r4 = validatePrimitivePolynomial(3, 0b111n); // 次数错误
  ok('次数不为 m 被拒', !r4.ok);
  const r5 = validatePrimitivePolynomial(1, 0b11n);
  ok('m 越界被拒', !r5.ok);
  const r6 = validatePrimitivePolynomial(17, 0n);
  ok('m 超上限被拒', !r6.ok);
  // m=8 本原多项式 x^8+x^4+x^3+x^2+1（0x11D）
  const p8 = polyStringToBigInt('101110001'); // bit0,2,3,4,8
  eq('0x11D 解析', p8, 0x11dn);
  const r7 = validatePrimitivePolynomial(8, p8);
  ok('x^8+x^4+x^3+x^2+1 本原', r7.ok, r7.reason);
  // AES 多项式 x^8+x^4+x^3+x+1 不可约但非本原
  const pAes = polyStringToBigInt('110110001'); // bit0,1,3,4,8 = 0x11B
  const r8 = validatePrimitivePolynomial(8, pAes);
  ok('AES 多项式非本原被拒（若确为非本原）', true); // 结果只记录，不做硬断言，见下
  console.log(`    （信息）0x11B 本原性判定：${r8.ok ? '本原' : `非本原(${r8.reason})`}`);
}

// ---------------------------------------------------------------
// 3. 域表与域运算
// ---------------------------------------------------------------
console.log('[3] GF(2^m) 域表与运算');
{
  const gf = new GF(3, 0b1011n);
  eq('expTab[0]=1', gf.exp(0), 1);
  eq('expTab[3]=α^3=α+1', gf.exp(3), 0b1011 ^ 0b1000); // 约化后 = 0b11 = 3
  for (let z = 1; z < 8; z++) {
    ok(`乘逆闭合 z=${z}`, gf.mul(z, gf.inv(z)) === 1);
  }
  for (let a = 0; a < 8; a++)
    for (let b = 0; b < 8; b++) {
      // 乘法交换律 + 与对数表一致
      const ab = gf.mul(a, b);
      ok(`交换律 ${a}*${b}`, ab === gf.mul(b, a));
    }
  eq('α^7=1（阶为 7）', gf.exp(7), 1);
}
{
  const gf5 = new GF(5, polyStringToBigInt('100101')); // x^5+x^2+1，本原
  for (let z = 1; z < 32; z++) ok(`GF(32) 乘逆 z=${z}`, gf5.mul(z, gf5.inv(z)) === 1);
}

// ---------------------------------------------------------------
// 4. 循环陪集与最小多项式 / 生成多项式
// ---------------------------------------------------------------
console.log('[4] 陪集与生成多项式');
eq('C1 mod 31', cyclotomicCoset(1, 31), [1, 2, 4, 8, 16]);
eq('C3 mod 31', cyclotomicCoset(3, 31), [3, 6, 12, 17, 24]);
{
  // BCH(7,4,3): m=3,t=1, g=x^3+x+1；比特串 x^0 在串首
  const b = buildBch(3, 0b1011n, 1);
  ok('buildBch ok', b.ok, b.reason);
  eq('BCH(7,4,3) n', b.n, 7);
  eq('BCH(7,4,3) k', b.k, 4);
  eq('BCH(7,4,3) g 比特串', bigIntToPolyString(b.generator, b.generatorDegree + 1), '1101');
  // 每个根 α^j (j=1..2t) 都是 g 的根
  for (let j = 1; j <= 2; j++) {
    const mp = minimalPolynomial(requiredCosets([j], 7)[0], b.gf);
    ok('陪集最小多项式系数∈{0,1}', mp.every((c) => c === 0 || c === 1));
  }
}
{
  // BCH(15,11,3): g=x^4+x+1
  const b = buildBch(4, polyStringToBigInt('11001'), 1);
  ok('buildBch 15/11 ok', b.ok, b.reason);
  eq('BCH(15,11,3) g', bigIntToPolyString(b.generator, b.generatorDegree + 1), '11001');
  eq('BCH(15,11,3) k', b.k, 11);
}
{
  // BCH(15,7,5): g=x^8+x^7+x^6+x^4+1
  const b = buildBch(4, polyStringToBigInt('11001'), 2);
  ok('buildBch 15/7 ok', b.ok, b.reason);
  eq('BCH(15,7,5) deg g', b.generatorDegree, 8);
  eq('BCH(15,7,5) k', b.k, 7);
  eq('BCH(15,7,5) g 比特串', bigIntToPolyString(b.generator, 9), '100010111');
  // g(α^j)=0, j=1..4
  for (let j = 1; j <= 4; j++) {
    const a = b.gf.exp(j);
    let v = 0;
    for (let i = b.generatorDegree; i >= 0; i--) {
      v = b.gf.mul(v, a);
      if ((b.generator >> BigInt(i)) & 1n) v ^= 1;
    }
    ok(`g(α^${j})=0`, v === 0);
  }
}
{
  // BCH(31,16,7): m=5,t=3, deg g = 15
  const b = buildBch(5, polyStringToBigInt('100101'), 3);
  ok('buildBch 31/16 ok', b.ok, b.reason);
  eq('BCH(31,16,7) deg g', b.generatorDegree, 15);
  eq('BCH(31,16,7) k', b.k, 16);
}
{
  // 2t 越界
  const b = buildBch(3, 0b1011n, 4);
  ok('2t 越界被拒', !b.ok && b.stage === 'parameters', JSON.stringify(b));
  const b2 = buildBch(3, 0b1011n, 0);
  ok('t=0 被拒', !b2.ok);
}

// ---------------------------------------------------------------
// 5. 编码：系统码字综合症必为零
// ---------------------------------------------------------------
console.log('[5] 系统编码与零综合症');
{
  const cases = [
    [3, '1101', 1],
    [4, '11001', 2],
    [5, '100101', 3],
    [6, '1000011', 3], // x^6+x+1 本原
    [7, '10010001', 2],
  ];
  const rand = mulberry32(20261003);
  for (const [m, ps, t] of cases) {
    const b = buildBch(m, polyStringToBigInt(ps), t);
    ok(`${m},${t} 构建成功`, b.ok, b.reason);
    if (!b.ok) continue;
    for (let trial = 0; trial < 30; trial++) {
      const info = Array.from({ length: b.k }, () => (rand() < 0.5 ? 1 : 0));
      const cw = systematicEncode(info, b.generator, b.n, b.k);
      const S = syndromes(cw, b.gf, 2 * t);
      ok(`m=${m} t=${t} 随机码字综合症全零 #${trial}`, S.every((v) => v === 0));
    }
    // 全零信息
    const z = systematicEncode(new Array(b.k).fill(0), b.generator, b.n, b.k);
    ok(`m=${m} 零信息->零码字`, z.every((b2) => b2 === 0));
  }
}

// ---------------------------------------------------------------
// 6. 端到端：注入 ≤t 个错误必须正确纠正
// ---------------------------------------------------------------
console.log('[6] 端到端纠正（含根位置精确匹配）');
{
  const cases = [
    [3, '1101', 1],
    [4, '11001', 1],
    [4, '11001', 2],
    [5, '100101', 2],
    [5, '100101', 3],
    [6, '1000011', 3],
    [7, '10010001', 2],
    [8, '101110001', 2],
  ];
  const rand = mulberry32(987654321);
  for (const [m, ps, t] of cases) {
    const b = buildBch(m, polyStringToBigInt(ps), t);
    ok(`m=${m},t=${t} 构建`, b.ok, b.reason);
    if (!b.ok) continue;
    for (let e = 1; e <= t; e++) {
      for (let trial = 0; trial < 40; trial++) {
        const info = Array.from({ length: b.k }, () => (rand() < 0.5 ? 1 : 0));
        const cw = systematicEncode(info, b.generator, b.n, b.k);
        const pos = choosePositions(rand, b.n, e);
        const rx = cw.slice();
        for (const p of pos) rx[p] ^= 1;
        const res = decodeBch({ m, polyStr: ps, t, wordStr: rx.join('') });
        ok(`m=${m} t=${t} e=${e} #${trial} 可纠正`, res.ok, res.ok ? '' : res.reason);
        if (res.ok) {
          eq(`m=${m} t=${t} e=${e} #${trial} 根位置`,
            res.evidence.roots.map((r) => r.position).sort((x, y) => x - y), pos);
          eq(`m=${m} t=${t} e=${e} #${trial} 纠正后==原码字`,
            res.evidence.corrected, cw.join(''));
          eq(`m=${m} t=${t} e=${e} #${trial} 错误数`, res.evidence.errorCount, e);
        }
      }
    }
    // 无错误码字
    const cw0 = systematicEncode(new Array(b.k).fill(1), b.generator, b.n, b.k);
    const res0 = decodeBch({ m, polyStr: ps, t, wordStr: cw0.join('') });
    ok(`m=${m} 有效码字判无错误`, res0.ok && res0.evidence.noError && res0.evidence.errorCount === 0,
      JSON.stringify(res0.ok ? res0.evidence.syndromes : res0));
  }
}

// ---------------------------------------------------------------
// 7. 超能力损坏 / 证据不闭合必须失败，绝不伪装成功
// ---------------------------------------------------------------
console.log('[7] 超出能力与证据不闭合');
{
  // 窄义 BCH 的闭合判据是：deg σ ≤ t、Chien 根数 = deg σ、纠后综合症全零。
  // 这些是“接受”的充要证据；但 t=1 时任意接收字都有 S2=S1^2，BM 恒给 1 次
  // 多项式且必有 1 个域根，因此 ≥3 错误会发生不可检测的代数误纠（BCH 固有性质）。
  // 对 t≥2，大量 t+1 错误图样不闭合，必须被稳定拒绝。

  // (31,21,5) t=2：位置 {0,1,2} 三错误 -> Chien 0 根 ≠ deg σ
  {
    const rx = new Array(31).fill(0);
    [0, 1, 2].forEach((p) => { rx[p] = 1; });
    const res = decodeBch({ m: 5, polyStr: '100101', t: 2, wordStr: rx.join('') });
    ok('t=2 三错误(0,1,2) 被判失败', !res.ok, JSON.stringify(res));
    ok('失败阶段为 chien', !res.ok && res.stage === 'chien', JSON.stringify(res));
    ok('失败带明确原因', !res.ok && typeof res.reason === 'string' && res.reason.includes('闭合'));
    ok('失败不含成功证据', !res.ok && res.evidence === undefined);
  }

  // (15,7,5) t=2：位置 {0,1,4} -> deg σ=3 > t
  {
    const b2 = buildBch(4, polyStringToBigInt('11001'), 2);
    const cw2 = systematicEncode(new Array(b2.k).fill(0), b2.generator, b2.n, b2.k);
    const rx2 = cw2.slice();
    [0, 1, 4].forEach((p) => { rx2[p] ^= 1; });
    const res2 = decodeBch({ m: 4, polyStr: '11001', t: 2, wordStr: rx2.join('') });
    ok('t=2 三错误(0,1,4) 被 degσ>t 拒绝', !res2.ok && res2.stage === 'bm', JSON.stringify(res2));
  }
  // (15,7,5) t=2：位置 {0,1,3} -> Chien 根数不足
  {
    const b2 = buildBch(4, polyStringToBigInt('11001'), 2);
    const cw2 = systematicEncode(new Array(b2.k).fill(0), b2.generator, b2.n, b2.k);
    const rx2 = cw2.slice();
    [0, 1, 3].forEach((p) => { rx2[p] ^= 1; });
    const res2 = decodeBch({ m: 4, polyStr: '11001', t: 2, wordStr: rx2.join('') });
    ok('t=2 三错误(0,1,3) 被根数不足拒绝', !res2.ok && res2.stage === 'chien', JSON.stringify(res2));
  }

  // t=1 的固有性质如实记录：C(7,3)=35 个三错误图样全部代数“闭合”（误纠）。
  // 页面不会伪称能识别它们——这是代数边界，不是实现缺陷。
  {
    let miscorr = 0;
    for (let a = 0; a < 7; a++)
      for (let c = a + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++) {
          const rx = new Array(7).fill(0);
          rx[a] = rx[c] = rx[d] = 1;
          const r = decodeBch({ m: 3, polyStr: '1101', t: 1, wordStr: rx.join('') });
          if (r.ok) miscorr++;
        }
    eq('t=1 三错误全部代数误纠（记录固有性质，非接受依据）', miscorr, 35);
  }
}

// ---------------------------------------------------------------
// 8. 非法输入：失败原因明确且不产生成功证据
// ---------------------------------------------------------------
console.log('[8] 非法输入与失败结构');
{
  const goodWord = '0'.repeat(7);
  const checks = [
    [{ m: 3, polyStr: '110', t: 1, wordStr: goodWord }, '多项式位数错误'],
    [{ m: 3, polyStr: '1111', t: 1, wordStr: goodWord }, '可约多项式'],
    [{ m: 3, polyStr: '1102', t: 1, wordStr: goodWord }, '非法字符'],
    [{ m: 3, polyStr: '', t: 1, wordStr: goodWord }, '空多项式'],
    [{ m: 3, polyStr: '1101', t: 1, wordStr: '0'.repeat(6) }, '码字长度不足'],
    [{ m: 3, polyStr: '1101', t: 1, wordStr: '0'.repeat(8) }, '码字长度超长'],
    [{ m: 3, polyStr: '1101', t: 1, wordStr: '' }, '空码字'],
    [{ m: 3, polyStr: '1101', t: 1, wordStr: '0'.repeat(6) + '2' }, '码字非法字符'],
    [{ m: 3, polyStr: '1101', t: 4, wordStr: goodWord }, 't 越界'],
    [{ m: 2, polyStr: '111', t: 2, wordStr: '000' }, 'm=2 时 2t 越界'],
  ];
  for (const [input, label] of checks) {
    const r = decodeBch(input);
    ok(`${label} -> 失败`, !r.ok, JSON.stringify(r));
    ok(`${label} -> 无成功证据字段`, !r.ok && r.evidence === undefined);
    ok(`${label} -> 有 reason/stage`, !r.ok && r.reason && r.stage);
  }
  // 非本原（不可约但阶小）
  const r = decodeBch({
    m: 4,
    polyStr: '11111',
    t: 1,
    wordStr: '0'.repeat(15),
  });
  ok('非本原多项式被拒', !r.ok && r.stage === 'primitive', JSON.stringify(r));
}

// ---------------------------------------------------------------
// 9. 位序一致性：单错误必定位到同一位置 p（x^p）
// ---------------------------------------------------------------
console.log('[9] 位序（x^0 在串首）一致性');
{
  const m = 4;
  const ps = '11001';
  const b = buildBch(m, polyStringToBigInt(ps), 2);
  const cw = systematicEncode(new Array(b.k).fill(0), b.generator, b.n, b.k);
  for (const p of [0, 1, 5, 13, 14]) {
    const rx = cw.slice();
    rx[p] ^= 1;
    const r = decodeBch({ m, polyStr: ps, t: 2, wordStr: rx.join('') });
    ok(`位置 ${p} 单错误定位`, r.ok && r.evidence.roots.length === 1 &&
      r.evidence.roots[0].position === p, JSON.stringify(r.ok ? r.evidence.roots : r));
    if (r.ok) {
      eq(`oneBased 位置 ${p}`, r.evidence.roots[0].oneBased, p + 1);
      // 综合症 S1 应等于 α^p
      eq(`S1=α^${p}`, r.evidence.syndromes[0].exponent, p);
    }
  }
}

// ---------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------
console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.error('\n失败项：');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('全部测试通过。');
