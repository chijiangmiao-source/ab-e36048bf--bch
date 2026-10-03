/**
 * bch.js — 窄义二进制本原 BCH 码的构造与解码验证
 *
 * 全局位序约定（与 gf.js 一致）：
 *   比特串 s 的第 i 个字符是 x^i 的系数，R(x) = Σ s[i]·x^i；
 *   生成多项式、接收码字、纠正后码字全部使用该位序展示。
 *
 * 窄义 BCH：生成多项式 g(x) 是以 α, α^2, ..., α^(2t) 为根的
 * 最小（GF(2) 上）多项式，即这些元素所在 2-循环陪集之最小多项式的乘积。
 */

import {
  GF,
  polyStringToBigInt,
  gf2PolyMul,
  gf2PolyMod,
  bigIntToPolyString,
  degreeOf,
  validatePrimitivePolynomial,
} from './gf.js';

/**
 * 模 n 的 2-循环陪集，起始元为 b：C_b = { b·2^j mod n }。
 */
export function cyclotomicCoset(b, n) {
  const set = [];
  let x = b % n;
  while (!set.includes(x)) {
    set.push(x);
    x = (x * 2) % n;
  }
  return set.sort((a, b2) => a - b2);
}

/**
 * 构造覆盖指数 roots（1..2t）所需的全部互不相同陪集。
 */
export function requiredCosets(rootExponents, n) {
  const seen = new Set();
  const cosets = [];
  for (const b of rootExponents) {
    const c = cyclotomicCoset(b, n);
    const key = c.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      cosets.push(c);
    }
  }
  return cosets;
}

/**
 * 元素 β 在 GF(2^m) 中的最小多项式 ∏_{j∈coset}(x + α^j)。
 * 返回系数数组（GF 元素的整数表示），下标为 x 的幂。
 * 因陪集对 Frobenius 封闭，系数必全部为 0 或 1。
 */
export function minimalPolynomial(coset, gf) {
  let coeff = [1]; // 多项式 1
  for (const j of coset) {
    const root = gf.exp(j);
    // coeff <- coeff * (x + root)
    const next = new Array(coeff.length + 1).fill(0);
    for (let i = 0; i < coeff.length; i++) {
      next[i] ^= gf.mul(coeff[i], root); // *root 项
      next[i + 1] ^= coeff[i]; // *x 项
    }
    coeff = next;
  }
  return coeff;
}

/** 系数数组（GF 元素整数）转 BigInt 比特多项式（仅在系数∈{0,1} 时有意义）。 */
function binaryCoeffsToBigInt(coeffs) {
  let v = 0n;
  coeffs.forEach((c, i) => {
    if (c !== 0 && c !== 1) {
      throw new Error('内部错误：期望二进制系数');
    }
    if (c === 1) v |= 1n << BigInt(i);
  });
  return v;
}

/**
 * 构造 BCH 参数描述。
 * 输入 m、本原多项式 BigInt p、纠错能力 t。
 * 返回 { ok, ... }；失败时带 reason/stage，不带任何成功证据。
 */
export function buildBch(m, p, t) {
  const prim = validatePrimitivePolynomial(m, p);
  if (!prim.ok) return { ok: false, stage: 'primitive', reason: prim.reason };

  if (!Number.isInteger(t) || t < 1) {
    return { ok: false, stage: 'parameters', reason: '纠错能力 t 必须是不小于 1 的整数' };
  }

  const n = 2 ** m - 1;
  if (2 * t > n - 1) {
    return {
      ok: false,
      stage: 'parameters',
      reason: `参数组合非法：2t=${2 * t} 超过非零指数范围 1..${n - 1}（n=2^m-1=${n}）`,
    };
  }

  const gf = new GF(m, p);
  const rootExponents = [];
  for (let j = 1; j <= 2 * t; j++) rootExponents.push(j);
  const cosets = requiredCosets(rootExponents, n);

  // g(x) = 各陪集最小多项式之积
  let g = 1n;
  const minPolys = [];
  for (const c of cosets) {
    const mp = minimalPolynomial(c, gf);
    minPolys.push({ exponents: c, coeffs: mp });
    g = gf2PolyMul(g, binaryCoeffsToBigInt(mp));
  }

  const degG = degreeOf(g);
  if (degG <= 0 || degG >= n) {
    return {
      ok: false,
      stage: 'generator',
      reason: `生成多项式次数 ${degG} 不满足有效码长 n=${n}（要求 0 < deg(g) < n）`,
    };
  }

  return {
    ok: true,
    m,
    p,
    t,
    n,
    k: n - degG,
    gf,
    cosets,
    minPolys,
    generator: g,
    generatorDegree: degG,
  };
}

/**
 * 综合症 S_j = R(α^j)，j=1..2t。Horner 法，按 R(x)=Σc[i]x^i 求值。
 */
export function syndromes(bits, gf, count) {
  const n = bits.length;
  const out = [];
  for (let j = 1; j <= count; j++) {
    const a = gf.exp(j);
    let s = 0;
    for (let i = n - 1; i >= 0; i--) {
      s = gf.mul(s, a);
      if (bits[i] === 1) s ^= 1;
    }
    out.push(s);
  }
  return out;
}

/**
 * Berlekamp–Massey，输入综合症域元素数组 S_1..S_N，
 * 返回错误定位多项式 σ(x) 系数数组（下标为 x 的幂，σ[0]=1）。
 */
export function berlekampMassey(S, gf) {
  const N = S.length;
  let C = [1]; // 当前连接多项式
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;

  const get = (arr, i) => (i < arr.length ? arr[i] : 0);
  const shiftMul = (poly, mm, scalar) => {
    const out = new Array(poly.length + mm).fill(0);
    for (let i = 0; i < poly.length; i++) {
      out[i + mm] = gf.mul(poly[i], scalar);
    }
    return out;
  };
  const addPoly = (a, b2) => {
    const len = Math.max(a.length, b2.length);
    const out = new Array(len).fill(0);
    for (let i = 0; i < len; i++) out[i] = get(a, i) ^ get(b2, i);
    return out;
  };

  for (let n = 0; n < N; n++) {
    // 差异 d = S[n] + Σ_{i=1..L} C[i]·S[n-i]
    let d = S[n];
    for (let i = 1; i <= L; i++) d ^= gf.mul(get(C, i), get(S, n - i));

    if (d === 0) {
      m++;
    } else {
      const T = C.slice();
      const coef = gf.div(d, b);
      C = addPoly(C, shiftMul(B, m, coef));
      if (2 * L <= n) {
        L = n + 1 - L;
        B = T;
        b = d;
        m = 1;
      } else {
        m++;
      }
    }
  }

  // 规整长度到 L+1
  const sigma = new Array(L + 1).fill(0);
  for (let i = 0; i <= L; i++) sigma[i] = get(C, i);
  if (sigma[0] !== 1) {
    // 理论上 BM 保持 σ[0]=1；若发生说明实现/输入异常
    throw new Error('BM 内部错误：定位多项式常数项不为 1');
  }
  return sigma;
}

/**
 * Chien 搜索：对每个比特位置 p（x^p 的系数位），检验 σ(α^{-p})=0。
 * 返回命中位置数组（升序）。
 */
export function chienSearch(sigma, gf, n) {
  const positions = [];
  const order = n; // 2^m-1
  for (let p = 0; p < n; p++) {
    const x = gf.exp((-p % order + order) % order); // α^{-p}
    // Horner 求 σ(x)
    let v = 0;
    for (let i = sigma.length - 1; i >= 0; i--) {
      v = gf.mul(v, x);
      v ^= sigma[i];
    }
    if (v === 0) positions.push(p);
  }
  return positions;
}

function fieldLabel(gf, z) {
  if (z === 0) return { kind: 'zero', text: '0', exponent: null, value: 0 };
  return { kind: 'power', text: `α^${gf.log(z)}`, exponent: gf.log(z), value: z };
}

/**
 * 系统编码：信息位放在高次端，低次端为校验位。
 * 输入信息比特串 inf[0..k-1] 对应 inf(x)=Σinf[i]x^i；
 * 输出长度 n 的比特数组，codeword(x) = inf(x)·x^(n-k) + (inf(x)·x^(n-k) mod g)。
 */
export function systematicEncode(infoBits, g, n, k) {
  if (infoBits.length !== k) throw new Error(`信息位长度应为 k=${k}`);
  let info = 0n;
  infoBits.forEach((b, i) => {
    if (b) info |= 1n << BigInt(i);
  });
  const shifted = info << BigInt(n - k);
  const rem = gf2PolyMod(shifted, g);
  const code = shifted ^ rem;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) out[i] = Number((code >> BigInt(i)) & 1n);
  return out;
}

/**
 * 完整复核流水线。
 *
 * @param {object} input { m:number, polyStr:string, t:number, wordStr:string }
 * @returns 成功时 { ok:true, evidence:{...} }；失败时 { ok:false, stage, reason }
 */
export function decodeBch(input) {
  const { m, polyStr, t } = input;
  const wordStr = String(input.wordStr ?? '').trim();

  // —— 输入位串校验先于一切，避免旧证据残留 ——
  let p;
  try {
    p = polyStringToBigInt(polyStr);
  } catch (e) {
    return { ok: false, stage: 'input', reason: `本原多项式比特串非法：${e.message}` };
  }

  // —— 本原多项式 + 参数 ——
  const built = buildBch(m, p, t);
  if (!built.ok) return { ok: false, stage: built.stage, reason: built.reason };
  const { gf, n, generator, generatorDegree } = built;

  if (wordStr.length === 0) {
    return { ok: false, stage: 'input', reason: '接收码字为空' };
  }
  if (!/^[01]+$/.test(wordStr)) {
    return { ok: false, stage: 'input', reason: '接收码字只能包含 0/1' };
  }
  if (wordStr.length !== n) {
    return {
      ok: false,
      stage: 'input',
      reason: `接收码字长度必须恰为 2^m-1=${n}，当前为 ${wordStr.length}`,
    };
  }

  const bits = Array.from(wordStr, (ch) => (ch === '1' ? 1 : 0));

  // —— 综合症 ——
  const S = syndromes(bits, gf, 2 * t);
  const syndromeInfo = S.map((v, idx) => ({ j: idx + 1, ...fieldLabel(gf, v) }));
  const allZero = S.every((v) => v === 0);

  // —— BM ——
  let sigma;
  try {
    sigma = berlekampMassey(S, gf);
  } catch (e) {
    return { ok: false, stage: 'bm', reason: `Berlekamp–Massey 失败：${e.message}` };
  }
  const sigmaDegree = sigma.length - 1;
  if (sigmaDegree > t) {
    return {
      ok: false,
      stage: 'bm',
      reason: `定位多项式次数 ${sigmaDegree} 超过纠错能力 t=${t}，损坏超出能力，不可靠纠正`,
    };
  }
  const sigmaInfo = sigma.map((v, i) => ({ power: i, ...fieldLabel(gf, v) }));

  // —— Chien 搜索 ——
  const positions = chienSearch(sigma, gf, n);
  if (positions.length !== sigmaDegree) {
    return {
      ok: false,
      stage: 'chien',
      reason: `定位证据无法闭合：σ 次数为 ${sigmaDegree}，Chien 仅找到 ${positions.length} 个根，损坏超出能力或参数不匹配`,
    };
  }

  // —— 纠正 ——
  const corrected = bits.slice();
  const rootInfo = positions.map((p) => ({
    position: p,
    oneBased: p + 1,
    root: fieldLabel(gf, gf.exp(((n - p) % n + n) % n)), // 根 α^{-p}
  }));
  for (const p of positions) corrected[p] ^= 1;

  // —— 纠正后综合症必须全部为零 ——
  const S2 = syndromes(corrected, gf, 2 * t);
  if (!S2.every((v) => v === 0)) {
    return {
      ok: false,
      stage: 'verify',
      reason: '定位证据无法闭合：纠正后综合症不全为零，拒绝把损坏伪装成正常数据',
    };
  }

  return {
    ok: true,
    evidence: {
      m,
      t,
      n,
      k: built.k,
      primitiveBits: polyStr.trim(),
      generatorBits: bigIntToPolyString(generator, generatorDegree + 1),
      generatorDegree,
      cosets: built.cosets.map((c) => c.slice()),
      syndromes: syndromeInfo,
      noError: allZero,
      sigma: sigmaInfo,
      sigmaDegree,
      roots: rootInfo,
      received: wordStr,
      corrected: corrected.join(''),
      errorCount: positions.length,
    },
  };
}
