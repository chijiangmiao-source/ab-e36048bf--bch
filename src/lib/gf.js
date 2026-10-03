/**
 * gf.js — 二进制有限域 GF(2^m) 原语
 *
 * 位序约定（全项目唯一约定，综合症 / Berlekamp–Massey / Chien 必须共用）：
 *   - 所有比特串按字符串下标左->右，解释为码字 c[0], c[1], ..., c[n-1]，
 *     对应多项式 R(x) = sum c[i] x^i，即串首是 x^0 的系数（"小端"位序）。
 *   - 域元素以整数表示，bit j 为基 α^j 的系数，即整数的 bit0 对应常数项。
 *
 * 该模块同时可被 Node 测试与浏览器 Web Worker 以 ES Module 方式导入，
 * 不依赖任何宿主专有 API。
 */

export const MIN_M = 2;
export const MAX_M = 16; // 2^16-1 = 65535，已是码字长度的实用上限

/** 把二进制/十六进制风格的表示解析为整数系数位的 BigInt（bit i = 系数 x^i）。 */
export function polyStringToBigInt(str) {
  if (typeof str !== 'string') throw new Error('多项式必须是字符串');
  const s = str.trim();
  if (s.length === 0) throw new Error('多项式比特串为空');
  if (!/^[01]+$/.test(s)) throw new Error('多项式比特串只能包含 0/1');
  let v = 0n;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '1') v |= 1n << BigInt(i);
  }
  return v;
}

/** 整系数多项式 -> 仅含 0/1 的比特串（bit0 在串首）。 */
export function bigIntToPolyString(v, len) {
  let out = '';
  const n = len ?? bitLength(v);
  for (let i = 0; i < n; i++) {
    out += (v >> BigInt(i)) & 1n ? '1' : '0';
  }
  return out;
}

export function bitLength(v) {
  let n = 0;
  while (v > 0n) {
    n++;
    v >>= 1n;
  }
  return n;
}

export function degreeOf(v) {
  return bitLength(v) - 1;
}

/** GF(2) 上多项式乘法（输入为比特整数，bit i = x^i 系数）。 */
export function gf2PolyMul(a, b) {
  let r = 0n;
  let x = a;
  while (b) {
    if (b & 1n) r ^= x;
    b >>= 1n;
    x <<= 1n;
  }
  return r;
}

/** GF(2) 上多项式带余除法：返回 { q, r }，使 a = q*b + r，deg r < deg b。 */
export function gf2PolyDivmod(a, b) {
  if (b === 0n) throw new Error('除零多项式');
  let r = a;
  let q = 0n;
  const db = BigInt(degreeOf(b));
  while (r !== 0n && degreeOf(r) >= Number(db)) {
    const shift = BigInt(degreeOf(r)) - db;
    q ^= 1n << shift;
    r ^= b << shift;
  }
  return { q, r };
}

export function gf2PolyMod(a, b) {
  return gf2PolyDivmod(a, b).r;
}

/** GF(2) 上 gcd（欧几里得），返回首一（GF(2) 上非零即首一）公因式。 */
export function gf2PolyGcd(a, b) {
  while (b) {
    [a, b] = [b, gf2PolyMod(a, b)];
  }
  return a;
}

/**
 * 判断 p 是否为 GF(2) 上次数恰为 m 的不可约多项式。
 * 采用有限域标准判据：p 不可约 <=> x^(2^m) ≡ x (mod p)
 * 且 gcd(x^(2^(m/q)) - x, p) = 1 对 m 的每个素因子 q 成立。
 * p 以 BigInt 比特整数给出，次数由调用者约束。
 */
export function isIrreducible(p, m) {
  if (m <= 0 || degreeOf(p) !== m) return false;
  // 常数项必须为 1，否则 x 是因子（m>=1）
  if ((p & 1n) === 0n) return false;

  // v = x mod p；反复平方 m 次后 v = x^(2^m) mod p
  let v = 2n % p; // x
  for (let i = 0; i < m; i++) v = gf2PolyMod(gf2PolyMul(v, v), p);
  const x = 2n % p;
  if (v !== x) return false;

  for (const q of primeFactors(m)) {
    // 计算 x^(2^(m/q)) mod p：从 x 起平方 m/q 次
    let w = x;
    for (let i = 0; i < m / q; i++) w = gf2PolyMod(gf2PolyMul(w, w), p);
    const g = gf2PolyGcd(p, w ^ x); // w - x 在 GF(2) 即 w + x
    if (g !== 1n) return false;
  }
  return true;
}

/** 整数的素因子（去重）。 */
export function primeFactors(n) {
  const out = [];
  let x = n;
  for (let d = 2; d * d <= x; d++) {
    if (x % d === 0) {
      out.push(d);
      while (x % d === 0) x /= d;
    }
  }
  if (x > 1) out.push(x);
  return out;
}

/**
 * 有限域 GF(2^m)，由 m 次本原多项式 p 构造。
 * expTab[k] = α^k 的整数表示（k 取 0 .. 2^m-2），
 * logTab[z] = z 以 α 为底的离散对数（logTab[0] = -1）。
 */
export class GF {
  constructor(m, p) {
    this.m = m;
    this.p = p;
    this.size = 2 ** m;
    this.mask = this.size - 1;
    const order = this.size - 1;
    this.expTab = new Int32Array(order + 1);
    this.logTab = new Int32Array(this.size).fill(-1);

    let x = 1;
    for (let k = 0; k < order; k++) {
      if (this.logTab[x] !== -1) {
        // α 在 k 之前已重复出现 -> 非本原，构造器不应走到这里
        throw new Error('多项式不是本原多项式：α 的阶小于 2^m-1');
      }
      this.expTab[k] = x;
      this.logTab[x] = k;
      x <<= 1;
      if (x & this.size) x ^= Number(p); // 模 p 约化（p 为整数）
    }
    this.expTab[order] = 1; // α^(2^m-1) = 1
  }

  /** α^k，指数按 mod (2^m-1) 归一化。 */
  exp(k) {
    const order = this.size - 1;
    let r = k % order;
    if (r < 0) r += order;
    return this.expTab[r];
  }

  log(x) {
    if (x === 0) throw new Error('0 没有对数');
    return this.logTab[x];
  }

  mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return this.expTab[(this.logTab[a] + this.logTab[b]) % (this.size - 1)];
  }

  /** 域元素倒数。 */
  inv(a) {
    if (a === 0) throw new Error('0 没有逆元');
    return this.expTab[(this.size - 1 - this.logTab[a]) % (this.size - 1)];
  }

  /** a / b。 */
  div(a, b) {
    return this.mul(a, this.inv(b));
  }
}

/** GF(2) 上模 p 的平方-乘快速幂：base^e mod p，均为 BigInt 比特多项式。 */
export function gf2PolyPowMod(base, e, p) {
  let result = 1n;
  let b = base;
  while (e > 0) {
    if (e & 1n) result = gf2PolyMod(gf2PolyMul(result, b), p);
    e >>= 1n;
    if (e) b = gf2PolyMod(gf2PolyMul(b, b), p);
  }
  return result;
}

/**
 * 验证 p 确实是 m 次本原多项式：
 *   1) 次数恰为 m；
 *   2) 不可约（Rabin 判据）；
 *   3) α 的阶恰为 2^m-1（不可约时等价于阶不被 2^m-1 的任一素因子整除）。
 * 返回 { ok:true } 或 { ok:false, reason }。
 */
export function validatePrimitivePolynomial(m, p) {
  if (!Number.isInteger(m) || m < MIN_M || m > MAX_M) {
    return { ok: false, reason: `域阶数 m 必须是 ${MIN_M}..${MAX_M} 的整数` };
  }
  if (p === 0n || degreeOf(p) !== m) {
    return {
      ok: false,
      reason: `多项式次数必须恰为 m=${m}（当前 ${p === 0n ? -1 : degreeOf(p)} 次）`,
    };
  }
  if (!isIrreducible(p, m)) {
    return { ok: false, reason: '该多项式在 GF(2) 上可约，不是不可约多项式' };
  }
  // 本原性：ord(α)=2^m-1。不可约时 ord 整除 2^m-1，
  // 只需验证对每个素因子 q，α^((2^m-1)/q) != 1。
  const order = 2 ** m - 1;
  for (const q of primeFactors(order)) {
    const x = gf2PolyPowMod(2n, BigInt(order / q), p); // α^((order)/q) mod p
    if (x === 1n) {
      return { ok: false, reason: `多项式不可约但不是本原的（α 的阶整除 (2^m-1)/${q}）` };
    }
  }
  return { ok: true };
}
