// ml/bandit.js —— 上下文 Bandit（LinUCB，disjoint 线性置信上界）
//
// v1 已有 Beta-Thompson（ecpm_engine.thompsonPick）：它是"无上下文"的，只能给每个 arm
// 一个全局胜率。问题是同一个素材在"美国 iOS 晚 8 点"和"印度安卓凌晨"表现完全不同——
// 无上下文 bandit 只能学到平均值，把上下文差异当成噪声。
//
// LinUCB 为每个 arm 维护一个岭回归（A, b）：
//   θ = A⁻¹b          期望收益
//   上界 = xᵀθ + α·√(xᵀA⁻¹x)
// 第二项是置信半径：该 arm 在这个上下文里"还没试过"时半径大 → 自动探索；
// 试够了半径收缩 → 收敛到 exploitation。这正是"大规模上下文 bandit"的标准做法。

const fs = require('./feature_store');

const ALPHA = Number(process.env.BANDIT_ALPHA || 0.6);
const RIDGE = 1.0;

let pool = null;
const arms = new Map(); // armKey -> {A:[[]], b:[], n}

function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_bandit_arm (
    arm_key VARCHAR(128) PRIMARY KEY, dim INT DEFAULT 0, a_json TEXT, b_json TEXT, n INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function newArm(d) {
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? RIDGE : 0)));
  return { A, b: new Array(d).fill(0), n: 0, dim: d, dirty: false };
}
function arm(key, d = fs.DIM) {
  let a = arms.get(key);
  if (!a) { a = newArm(d); arms.set(key, a); }
  if (a.dim !== d) { a = newArm(d); arms.set(key, a); }   // 特征维度变更 → 丢弃旧参数
  return a;
}

// 解 A·θ = b（高斯消元）。d 通常 ≤ 32，代价可接受；生产可换 Cholesky
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) continue;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map(row => row[n]);
}
// 计算 xᵀA⁻¹x：等价于解 A z = x 后取 xᵀz
function quadForm(A, x) {
  const z = solve(A, x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * z[i];
  return Math.max(0, s);
}

/**
 * 选臂：返回 {key, score, ucb, expected, explore}
 * @param {Array<{key:string, ctx:object}>} candidates
 */
function choose(candidates, opts = {}) {
  if (!candidates.length) return null;
  const alpha = Number(opts.alpha || ALPHA);
  const scored = candidates.map(c => {
    const x = fs.compute(c.ctx || {});
    const a = arm(c.key, x.length);
    const theta = solve(a.A, a.b);
    let expected = 0;
    for (let i = 0; i < x.length; i++) expected += theta[i] * x[i];
    const radius = alpha * Math.sqrt(quadForm(a.A, x));
    return { key: c.key, x, expected, radius, ucb: expected + radius };
  });
  scored.sort((p, q) => q.ucb - p.ucb);
  const top = scored[0];
  return { key: top.key, ucb: +top.ucb.toFixed(5), expected: +top.expected.toFixed(5), radius: +top.radius.toFixed(5), explore: top.radius > Math.abs(top.expected) * 0.5, all: scored.map(s => ({ key: s.key, ucb: +s.ucb.toFixed(5) })) };
}

/**
 * 回报更新：reward 建议归一化到 [0,1]（如 ctr、cvr、或 value/目标值）
 */
function update(key, ctx, reward) {
  const x = fs.compute(ctx || {});
  const a = arm(key, x.length);
  const r = Number(reward) || 0;
  // Sherman-Morrison 只适用于矩阵逆；这里直接更新 A 与 b（A += xxᵀ）
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < x.length; j++) a.A[i][j] += x[i] * x[j];
    a.b[i] += x[i] * r;
  }
  a.n++; a.dirty = true;
  return a.n;
}

// 出价系数选择：把连续系数离散成 arm，用 bandit 学"这个上下文该激进还是保守"
const MULT_ARMS = [0.5, 0.7, 0.85, 1.0, 1.2, 1.5];
function chooseBidMultiplier(ctx, scope = 'global') {
  const out = choose(MULT_ARMS.map(m => ({ key: `bidmul:${scope}:${m}`, ctx })));
  const m = out ? Number(String(out.key).split(':').pop()) : 1;
  return { multiplier: m, ...out };
}
function rewardBidMultiplier(scope, m, ctx, reward) { return update(`bidmul:${scope}:${m}`, ctx, reward); }

async function load() {
  if (!pool) return;
  try {
    const [rows] = await pool.query('SELECT arm_key,a_json,b_json,n FROM ml_bandit_arm');
    let n = 0;
    for (const r of rows) {
      const A = safeJson(r.a_json), b = safeJson(r.b_json);
      if (!Array.isArray(A) || !Array.isArray(b) || A.length !== b.length) continue;
      if (A.length !== fs.DIM) continue;
      arms.set(r.arm_key, { A, b, n: Number(r.n) || 0, dim: A.length, dirty: false });
      n++;
    }
    if (n) console.log(`[bandit] 已加载 ${n} 个 arm`);
  } catch (e) {}
}
async function flush() {
  if (!pool) return;
  for (const [k, a] of arms) {
    if (!a.dirty) continue;
    await pool.query(`INSERT INTO ml_bandit_arm (arm_key,dim,a_json,b_json,n) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE a_json=VALUES(a_json), b_json=VALUES(b_json), n=VALUES(n), dim=VALUES(dim)`,
      [k, a.dim, JSON.stringify(a.A), JSON.stringify(a.b), a.n]).catch(() => {});
    a.dirty = false;
  }
}
function snapshot() {
  const out = {};
  for (const [k, a] of arms) if (a.n) out[k] = { n: a.n };
  return out;
}

module.exports = {
  attachPool, initTables, load, flush, choose, update, arm, solve,
  chooseBidMultiplier, rewardBidMultiplier, snapshot, MULT_ARMS, _arms: arms,
};
