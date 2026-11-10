// ステップ動作の解析ロジック。DOMに依存しない純粋関数。
export let VISIBILITY_THRESHOLD = 0.5;
let ENGINE_NOTE = "MediaPipe Pose Landmarker（heavy）による動画各フレームの2D推定値";
export function setEngine(engine) {
  if (engine === "rtmpose") {
    VISIBILITY_THRESHOLD = 0.3;
    ENGINE_NOTE = "RTMPose（Halpe26、人物検出はYOLOX）による動画各フレームの2D推定値。MediaPipe Poseと同じ33点の並びに変換（foot_indexは母趾、visibilityはRTMPoseの信頼度を0〜1に収めた値）。";
  } else {
    VISIBILITY_THRESHOLD = 0.5;
    ENGINE_NOTE = "MediaPipe Pose Landmarker（heavy）による動画各フレームの2D推定値";
  }
}
export const engineNote = () => ENGINE_NOTE;

export const SKELETON_CONNECTIONS = [
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];
export const IDS = {
  left: { shoulder: 11, hip: 23, knee: 25, ankle: 27, heel: 29, foot_index: 31 },
  right: { shoulder: 12, hip: 24, knee: 26, ankle: 28, heel: 30, foot_index: 32 },
};
export const SIDES = ["left", "right"];
const JOINTS = ["shoulder", "hip", "knee", "ankle", "heel", "foot_index"];
export const other = (s) => (s === "left" ? "right" : "left");
export const sideJ = (s) => (s === "left" ? "左" : "右");

const round = (v, d) => { if (!Number.isFinite(v)) return null; const f = 10 ** d; return Math.round(v * f) / f; };
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const mean = (a) => { const v = a.filter(isNum); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
const sd = (a) => { const v = a.filter(isNum); if (v.length < 2) return NaN; const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); };
const median = (a) => { const v = a.filter(isNum).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const DEG = 180 / Math.PI;

// ---------- 対象者の選択と追跡 ----------
function hipCenter(pose, w, h) {
  const pts = [23, 24].filter((i) => pose[i] && (pose[i].visibility ?? 1) >= VISIBILITY_THRESHOLD).map((i) => [pose[i].x * w, pose[i].y * h]);
  if (!pts.length) return null;
  return [mean(pts.map((p) => p[0])), mean(pts.map((p) => p[1]))];
}
export function bodyCenter(pose, w, h) {
  const ids = [11, 12, 23, 24].filter((i) => pose[i] && Number.isFinite(pose[i].x));
  if (!ids.length) return null;
  return [mean(ids.map((i) => pose[i].x * w)), mean(ids.map((i) => pose[i].y * h))];
}
function bodySize(pose, w, h) { // 肩の中点〜足首の中点（px）
  const m = (a, b) => [((pose[a].x + pose[b].x) / 2) * w, ((pose[a].y + pose[b].y) / 2) * h];
  const s = m(11, 12), a = m(27, 28);
  const d = Math.hypot(s[0] - a[0], s[1] - a[1]);
  return Number.isFinite(d) && d > 1 ? d : h * 0.3;
}
// 体の向きの側（前側）にいる人
export function chooseFrontPose(poses, w, h, facing) {
  let best = null, bestVal = -Infinity;
  for (const p of poses || []) {
    const c = hipCenter(p, w, h) || bodyCenter(p, w, h);
    if (c && c[0] * facing > bestVal) { bestVal = c[0] * facing; best = p; }
  }
  return best;
}
function bboxContains(pose, w, h, x, y) {
  const xs = pose.map((p) => p.x * w), ys = pose.map((p) => p.y * h);
  return x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys);
}
// タップ位置の人：体幹中心に近い人を優先（骨格の範囲に入っていれば候補）
export function choosePoseAtPoint(poses, w, h, x, y) {
  let best = null, bestS = Infinity;
  for (const p of poses || []) {
    const c = bodyCenter(p, w, h);
    if (!c) continue;
    const d = Math.hypot(c[0] - x, c[1] - y) / bodySize(p, w, h);
    const inside = bboxContains(p, w, h, x, y);
    if (!inside && d > 0.15) continue;
    const s = d - (inside ? 1 : 0);
    if (s < bestS) { bestS = s; best = p; }
  }
  return best;
}
// フレームをまたいで同じ人を追う。候補が複数あるときは前側の人を優先。
// 見失ったフレームは null（他の人に乗り換えない）。1秒以上見失ったら前側の人を選び直す。
const TRACK_PAIRS = [[11, 12, 2], [23, 24, 2], [25, 26, 1], [27, 28, 1]];
function poseDistance(p, last, v, df, w, h) {
  const d = (a, b) => (p[a] && last[b] ? Math.hypot(p[a].x * w - (last[b].x * w + v[0] * df), p[a].y * h - (last[b].y * h + v[1] * df)) : NaN);
  let s = 0, n = 0;
  for (const [a, b, wt] of TRACK_PAIRS) {
    const m = Math.min((d(a, a) + d(b, b)) / 2, (d(a, b) + d(b, a)) / 2); // 左右の取り違えに強くする
    if (Number.isFinite(m)) { s += m * wt; n += wt; }
  }
  return n ? s / n : Infinity;
}
export class TargetTracker {
  constructor(w, h, fps) { this.w = w; this.h = h; this.fps = fps; this.state = null; this.seed = null; this.lost = 0; this.reacquired = 0; }
  seedPoint(x, y) { this.seed = [x, y]; this.state = null; }
  step(poses, frame, facing) {
    const w = this.w, h = this.h;
    poses = poses || [];
    if (!this.state) {
      let p = null;
      if (this.seed) { p = choosePoseAtPoint(poses, w, h, this.seed[0], this.seed[1]); if (p) this.seed = null; }
      else p = chooseFrontPose(poses, w, h, facing);
      if (p) this._set(p, frame, [0, 0]);
      return p;
    }
    const st = this.state, df = frame - st.frame || 1, gap = Math.abs(df);
    const gate = Math.max(0.12 * st.size, 0.02 * w) * (1 + 0.05 * (gap - 1));
    const ok = [];
    for (const p of poses) {
      const d = poseDistance(p, st.pose, st.v, df, w, h);
      if (d <= gate) ok.push({ p, d, c: bodyCenter(p, w, h) });
    }
    if (ok.length) {
      // 近い候補が複数あるとき（介助者と重なったとき）は前側の人を優先
      const fmax = Math.max(...ok.map((o) => o.c[0] * facing));
      ok.forEach((o) => (o.s = o.d + 0.3 * st.size * clamp((fmax - o.c[0] * facing) / st.size, 0, 1)));
      ok.sort((a, b) => a.s - b.s);
      const best = ok[0].p, c = ok[0].c;
      const v = [0.6 * st.v[0] + 0.4 * ((c[0] - st.c[0]) / df), 0.6 * st.v[1] + 0.4 * ((c[1] - st.c[1]) / df)];
      this._set(best, frame, v, st.size);
      return best;
    }
    this.lost++;
    if (gap > this.fps) {
      this.state = null;
      const p = this.step(poses, frame, facing);
      if (p) this.reacquired++;
      return p;
    }
    return null;
  }
  _set(p, frame, v, prevSize) {
    const size = bodySize(p, this.w, this.h);
    this.state = { pose: p, c: bodyCenter(p, this.w, this.h), v, frame, size: prevSize ? 0.8 * prevSize + 0.2 * size : size };
  }
}
// seeds: [{frame, x, y}]（x,yは0〜1）。指定ごとに、その場面から次の指定の手前まで追跡する。
export function trackAll(cands, w, h, fps, facing, seeds = []) {
  const n = cands.length, sel = new Array(n).fill(null);
  let lost = 0, reacquired = 0;
  const run = (from, to, seed, backTo) => {
    const T = new TargetTracker(w, h, fps);
    if (seed) T.seedPoint(seed.x * w, seed.y * h);
    let first = -1;
    for (let i = from; i <= to; i++) {
      sel[i] = T.step(cands[i], i, facing);
      if (first < 0 && sel[i]) first = i;
    }
    if (first >= 0 && first - 1 >= backTo) {
      // 最初に見つかった場面から逆向きにも追跡
      const B = new TargetTracker(w, h, fps);
      const tmp = new TargetTracker(w, h, fps); tmp._set(sel[first], first, [0, 0]); B.state = tmp.state;
      for (let i = first - 1; i >= backTo; i--) sel[i] = B.step(cands[i], i, facing);
      lost += B.lost; reacquired += B.reacquired;
    }
    lost += T.lost; reacquired += T.reacquired;
  };
  const ss = (seeds || []).map((s) => ({ ...s, frame: clamp(Math.round(s.frame), 0, n - 1) })).sort((a, b) => a.frame - b.frame);
  if (!n) return { sel, lost, reacquired, seeded: 0 };
  if (!ss.length) {
    // 最初の2秒で人数が最も多いフレームから始める（前側の人を選びやすくする）
    let start = -1, most = 0;
    for (let i = 0; i < Math.min(n, Math.round(fps * 2)); i++) if ((cands[i] || []).length > most) { most = cands[i].length; start = i; }
    if (start < 0) start = cands.findIndex((c) => c && c.length);
    if (start >= 0) run(start, n - 1, null, 0);
  } else {
    ss.forEach((s, k) => run(s.frame, k + 1 < ss.length ? ss[k + 1].frame - 1 : n - 1, s, k === 0 ? 0 : s.frame));
  }
  return { sel, lost, reacquired, seeded: ss.length };
}

// ---------- フレーム別の行 ----------
export function buildRow(i, fps, w, h, pose) {
  const row = { frame: i, time_seconds: round(i / fps, 4), detected: pose ? 1 : 0 };
  for (const s of SIDES) for (const j of JOINTS) {
    const lm = pose ? pose[IDS[s][j]] : null;
    row[`${s}_${j}_x_px`] = lm ? round(lm.x * w, 2) : null;
    row[`${s}_${j}_y_px`] = lm ? round(lm.y * h, 2) : null;
    row[`${s}_${j}_visibility`] = lm && lm.visibility != null ? round(lm.visibility, 4) : null;
  }
  return row;
}
// 可視性がしきい値以上の点
function P(r, s, j, thr) {
  const x = r[`${s}_${j}_x_px`], y = r[`${s}_${j}_y_px`], v = r[`${s}_${j}_visibility`];
  if (!isNum(x) || !isNum(y)) return null;
  if (isNum(v) && v < thr) return null;
  return [x, y];
}
// 2点のベクトルaからbへの符号付き角度（度、画像座標）
const signedAngle = (a, b) => Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * DEG;
const vec = (p, q) => [q[0] - p[0], q[1] - p[1]];
const mid = (p, q) => (p && q ? [(p[0] + q[0]) / 2, (q[1] + p[1]) / 2] : p || q);

// 角度（facing: 画面上の体の向き。右向き=+1）
export function anglesOf(r, facing, thr) {
  const out = {};
  for (const s of SIDES) {
    const sh = P(r, s, "shoulder", thr), hp = P(r, s, "hip", thr), kn = P(r, s, "knee", thr), an = P(r, s, "ankle", thr);
    const he = P(r, s, "heel", thr), ft = P(r, s, "foot_index", thr);
    // 股関節：体幹（肩→股の延長）に対する大腿（股→膝）の角度。屈曲＋、伸展−
    out[`${s}_hip_flexion_deg`] = sh && hp && kn ? round(-signedAngle(vec(sh, hp), vec(hp, kn)) * facing, 2) : null;
    // 膝：大腿と下腿のなす角から。伸展位≈0、屈曲＋
    let knee = null;
    if (hp && kn && an) {
      const a = vec(kn, hp), b = vec(kn, an), na = Math.hypot(...a), nb = Math.hypot(...b);
      if (na > 1e-6 && nb > 1e-6) knee = round(180 - Math.acos(clamp((a[0] * b[0] + a[1] * b[1]) / (na * nb), -1, 1)) * DEG, 2);
    }
    out[`${s}_knee_flexion_deg`] = knee;
    // 足関節：下腿（足関節→膝）と足部（踵→つま先）のなす角−90。背屈＋、底屈−
    let ank = null;
    if (kn && an && he && ft) {
      const a = vec(an, kn), b = vec(he, ft), na = Math.hypot(...a), nb = Math.hypot(...b);
      if (na > 1e-6 && nb > 1e-6) ank = round(90 - Math.acos(clamp((a[0] * b[0] + a[1] * b[1]) / (na * nb), -1, 1)) * DEG, 2);
    }
    out[`${s}_ankle_dorsiflexion_deg`] = ank;
  }
  // 体幹の傾き：股関節の中点→肩の中点の、鉛直に対する角度。前傾＋、後傾−
  const shc = mid(P(r, "left", "shoulder", thr), P(r, "right", "shoulder", thr));
  const hpc = mid(P(r, "left", "hip", thr), P(r, "right", "hip", thr));
  out.trunk_tilt_deg = shc && hpc ? round(signedAngle([0, -1], vec(hpc, shc)) * facing, 2) : null;
  return out;
}

// ---------- 系列の処理 ----------
export function interpolateBoth(values) {
  const v = values.map((x) => (isNum(x) ? x : NaN));
  const valid = [];
  v.forEach((x, i) => { if (!Number.isNaN(x)) valid.push(i); });
  if (!valid.length) return v;
  const out = v.slice();
  for (let i = 0; i < valid[0]; i++) out[i] = v[valid[0]];
  const last = valid[valid.length - 1];
  for (let i = last + 1; i < v.length; i++) out[i] = v[last];
  for (let k = 0; k < valid.length - 1; k++) {
    const a = valid[k], b = valid[k + 1];
    for (let i = a + 1; i < b; i++) out[i] = v[a] + ((v[b] - v[a]) * (i - a)) / (b - a);
  }
  return out;
}
const winOf = (fps) => Math.max(3, Math.round(fps * 0.12) | 1);
function smooth(values, fps) {
  const v = interpolateBoth(values);
  if (!v.length || !v.every(Number.isFinite)) return null;
  const half = Math.floor(winOf(fps) / 2), n = v.length;
  return v.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += v[j]; c++; }
    return s / c;
  });
}
function runs(flags, minLen) {
  const out = []; let st = -1;
  for (let i = 0; i <= flags.length; i++) {
    const f = i < flags.length && flags[i];
    if (f && st < 0) st = i;
    if (!f && st >= 0) { if (i - st >= minLen) out.push([st, i - 1]); st = -1; }
  }
  return out;
}

// ---------- 換算区間（膝が伸びて立っている区間） ----------
export const CALIB = { stillRatio: 0.15, kneeMaxDeg: 20, staggerRatio: 0.05, minSec: 0.3 };
const CALIB_LEVELS = [
  "基準足・踏み出す足の前後関係＋膝の前後関係＋膝伸展＋静止",
  "膝伸展＋静止（前後関係の条件を外して検出）",
  "静止のみ（膝の条件をゆるめて検出）",
];

// ---------- 全体の計算 ----------
// p: { fps, W, H, facing, stepDir: "forward"|"backward", refSide, stepSide, legCm, calibManual: {a,b}|null, thr }
export function computeAll(rawRows, p) {
  const { fps, H, facing } = p, thr = p.thr ?? VISIBILITY_THRESHOLD;
  const n = rawRows.length, M = p.stepSide, S = other(M);
  const warnings = [];
  const rows = rawRows.map((r) => ({ ...r, ...anglesOf(r, facing, thr) }));
  // 下肢長（股関節の点〜足関節の点、px）
  const legPx = (r, s) => { const a = P(r, s, "hip", thr), b = P(r, s, "ankle", thr); return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null; };
  rows.forEach((r) => { for (const s of SIDES) r[`${s}_leg_px`] = round(legPx(r, s), 2); });
  const legMed = median(rows.flatMap((r) => [r.left_leg_px, r.right_leg_px]));
  if (!isNum(legMed)) return { rows, steps: [], others: [], calib: null, summary: null, warnings: ["対象者の下肢（股関節・足関節）を検出できませんでした。"] };

  // 足の水平位置（踵と足関節の平均）
  const footX = (s) => rows.map((r) => { const a = P(r, s, "heel", thr), b = P(r, s, "ankle", thr); return a && b ? (a[0] + b[0]) / 2 : a ? a[0] : b ? b[0] : null; });
  const xs = { left: smooth(footX("left"), fps), right: smooth(footX("right"), fps) };
  if (!xs[M]) return { rows, steps: [], others: [], calib: null, summary: null, warnings: [`${sideJ(M)}足（踏み出す足）を検出できませんでした。`] };

  // ---- ステップ（踏み出す足の離地〜踵の接地） ----
  const xM = xs[M];
  const vel = xM.map((_, i) => ((xM[Math.min(n - 1, i + 1)] - xM[Math.max(0, i - 1)]) * fps / (Math.min(n - 1, i + 1) - Math.max(0, i - 1) || 1)) * facing);
  const thrV = 0.25 * legMed, lowV = 0.1 * legMed;
  let segs = [];
  for (const sign of [1, -1]) for (const [a, b] of runs(vel.map((v) => v * sign > thrV), 1)) segs.push({ a, b, sign });
  segs.sort((x, y) => x.a - y.a);
  const merged = [];
  for (const s of segs) { // 同じ向きで0.1秒以内に続く区間はまとめる
    const last = merged[merged.length - 1];
    if (last && last.sign === s.sign && s.a - last.b <= Math.round(fps * 0.1)) last.b = s.b; else merged.push({ ...s });
  }
  const heelY = smooth(rows.map((r) => (P(r, M, "heel", thr) || [null, null])[1]), fps);
  const heelYraw = interpolateBoth(rows.map((r) => (P(r, M, "heel", thr) || [null, null])[1]));
  const tolY = Math.max(0.004 * H, 0.015 * legMed), half = Math.floor(winOf(fps) / 2);
  const moves = [];
  for (const sg of merged) {
    if (Math.abs(xM[sg.b] - xM[sg.a]) < 0.08 * legMed || sg.b - sg.a + 1 < Math.max(2, Math.round(fps * 0.08))) continue;
    let lo = sg.a, hi = sg.b;
    for (let k = 0; k < Math.round(fps * 0.25) && lo > 0 && vel[lo - 1] * sg.sign > lowV; k++) lo--;
    for (let k = 0; k < Math.round(fps * 0.3) && hi < n - 1 && vel[hi + 1] * sg.sign > lowV; k++) hi++;
    let peak = sg.a;
    for (let i = sg.a; i <= sg.b; i++) if (vel[i] * sg.sign > vel[peak] * sg.sign) peak = i;
    // 踵の接地：踏み出した後に踵が床の高さ（着地後0.3秒の中央値）に最初に戻ったフレーム
    let contact = hi, contactBy = "水平移動の終了（踵を検出できず）";
    if (heelY) {
      const g = median(heelY.slice(hi, Math.min(n, hi + Math.round(fps * 0.3) + 1)));
      const end = Math.min(n - 1, hi + Math.round(fps * 0.5));
      for (let i = peak; i <= end; i++) if (heelY[i] >= g - tolY) { contact = i; contactBy = "踵の接地"; break; }
      if (contactBy === "踵の接地") for (let i = Math.max(peak, contact - half); i <= contact; i++) if (Number.isFinite(heelYraw[i]) && heelYraw[i] >= g - tolY) { contact = i; break; }
    }
    if (contact <= lo) contact = hi;
    if (lo === 0 || hi === n - 1) { warnings.push(`${round(lo / fps, 2)}秒付近の動きは動画の端で途切れているため除外しました。`); continue; }
    moves.push({ lo, contact, peak, end: hi, sign: sg.sign, contactBy });
  }

  // ---- 換算区間 ----
  const wantSign = p.stepDir === "backward" ? -1 : 1;
  const firstStep = moves.find((m) => m.sign === wantSign);
  let calib = null;
  const calibFrom = (a, b, level, label) => {
    const lp = {}, ok = {};
    for (const s of SIDES) { const v = rows.slice(a, b + 1).map((r) => r[`${s}_leg_px`]); lp[s] = mean(v); ok[s] = v.filter(isNum).length; }
    const both = [lp.left, lp.right].filter(isNum);
    if (!both.length) return null;
    const pxMean = mean(both);
    const sc = (px) => (isNum(px) && p.legCm > 0 ? p.legCm / px : null);
    const kn = (s) => round(mean(rows.slice(a, b + 1).map((r) => r[`${s}_knee_flexion_deg`])), 1);
    return {
      a, b, start_seconds: round(a / fps, 3), end_seconds: round(b / fps, 3), level, method: label,
      leg_px_left: round(lp.left, 2), leg_px_right: round(lp.right, 2), leg_px_mean: round(pxMean, 2),
      scale_mean: sc(pxMean), scale_left: sc(lp.left), scale_right: sc(lp.right),
      knee_left_deg: kn("left"), knee_right_deg: kn("right"),
    };
  };
  if (p.calibManual) {
    const a = clamp(Math.round(p.calibManual.a), 0, n - 1), b = clamp(Math.round(p.calibManual.b), a, n - 1);
    calib = calibFrom(a, b, -1, "手動で指定");
    if (!calib) warnings.push("指定した区間で下肢を検出できませんでした。");
  } else {
    const hipX = smooth(rows.map((r) => mid(P(r, "left", "hip", thr), P(r, "right", "hip", thr))?.[0] ?? null), fps);
    const sp = (arr) => (arr ? arr.map((_, i) => Math.abs((arr[Math.min(n - 1, i + 1)] - arr[Math.max(0, i - 1)]) * fps / 2)) : null);
    const vs = [sp(xs.left), sp(xs.right), sp(hipX)].filter(Boolean);
    const still = rows.map((_, i) => vs.every((v) => v[i] < CALIB.stillRatio * legMed));
    const kneeOk = (r, lim) => SIDES.every((s) => isNum(r[`${s}_knee_flexion_deg`]) && r[`${s}_knee_flexion_deg`] < lim);
    const kneeX = (s) => smooth(rows.map((r) => (P(r, s, "knee", thr) || [null])[0]), fps);
    const kS = kneeX(S), kM = kneeX(M);
    // 前方ステップ：基準足（支持側）が前、後方ステップ：踏み出す足が前（ステップ前の構え）
    const stagger = rows.map((_, i) => {
      if (!xs[S] || !kS || !kM) return false;
      const d = (xs[S][i] - xM[i]) * facing * wantSign, dk = (kS[i] - kM[i]) * facing * wantSign;
      return d > CALIB.staggerRatio * legMed && dk > 0.5 * CALIB.staggerRatio * legMed;
    });
    const minLen = Math.max(3, Math.round(fps * CALIB.minSec));
    const conds = [
      (i) => still[i] && stagger[i] && kneeOk(rows[i], CALIB.kneeMaxDeg),
      (i) => still[i] && kneeOk(rows[i], CALIB.kneeMaxDeg),
      (i) => still[i] && kneeOk(rows[i], 40),
    ];
    for (let L = 0; L < conds.length && !calib; L++) {
      const rs = runs(rows.map((_, i) => conds[L](i)), minLen);
      if (!rs.length) continue;
      const len = (r) => r[1] - r[0];
      const before = firstStep ? rs.filter((r) => r[1] <= firstStep.lo) : [];
      const pick = (before.length ? before : rs).reduce((x, y) => (len(y) > len(x) ? y : x));
      calib = calibFrom(pick[0], pick[1], L, "自動：" + CALIB_LEVELS[L] + (before.length ? "（最初のステップより前）" : ""));
    }
    if (!calib) warnings.push("膝が伸びて静止している区間を自動で見つけられませんでした。結果画面で換算区間を指定してください。");
    else if (calib.level > 0) warnings.push(`換算区間は「${CALIB_LEVELS[calib.level]}」で求めました。結果画面で区間を確認してください。`);
  }
  if (!(p.legCm > 0)) warnings.push("下肢長が未入力のため、cmへの換算はしていません。");
  const scale = calib ? calib.scale_mean : null;

  // ---- 各ステップの集計 ----
  const at = (s, j, f) => { const q = P(rows[f], s, j, thr); return q ? q[0] : NaN; };
  const avgX = (s, j, a, b) => interpolateBoth(rows.map((_, i) => at(s, j, i))).slice(Math.max(0, a), Math.min(n, b + 1)).reduce((t, x, _, arr) => t + x / arr.length, 0);
  const keys = [];
  for (const s of SIDES) for (const j of ["hip_flexion", "knee_flexion", "ankle_dorsiflexion"]) keys.push(`${s}_${j}`);
  keys.push("trunk_tilt");
  const r1 = (x) => round(x, 1), r2 = (x) => round(x, 2), r3 = (x) => round(x, 3);
  const mk = (m, idx) => {
    const o = {
      step: idx, direction: m.sign > 0 ? "前方" : "後方", step_side: M, stance_side: S,
      liftoff_frame: m.lo, liftoff_time_seconds: r3(m.lo / fps), contact_frame: m.contact, contact_time_seconds: r3(m.contact / fps),
      step_time_seconds: r3((m.contact - m.lo) / fps), contact_detected_by: m.contactBy,
    };
    for (const j of ["heel", "ankle"]) {
      const before = avgX(M, j, m.lo - 2, m.lo), after = avgX(M, j, m.contact, m.contact + 2);
      const dpx = (after - before) * facing; // 前方＋
      o[`${j}_displacement_px`] = r2(dpx);
      o[`${j}_distance_cm`] = scale ? r1(Math.abs(dpx) * scale) : null;
      o[`${j}_distance_percent_leg`] = calib ? r1((100 * Math.abs(dpx)) / calib.leg_px_mean) : null;
      o[`${j}_distance_cm_by_left_leg`] = calib && calib.scale_left ? r1(Math.abs(dpx) * calib.scale_left) : null;
      o[`${j}_distance_cm_by_right_leg`] = calib && calib.scale_right ? r1(Math.abs(dpx) * calib.scale_right) : null;
    }
    o.leg_length_cm = p.legCm || null;
    o.calib_start_seconds = calib ? calib.start_seconds : null;
    o.calib_end_seconds = calib ? calib.end_seconds : null;
    o.calib_method = calib ? calib.method : "なし";
    o.leg_px_mean = calib ? calib.leg_px_mean : null;
    o.scale_cm_per_px = scale ? round(scale, 6) : null;
    let det = 0;
    for (let i = m.lo; i <= m.contact; i++) det += rows[i].detected ? 1 : 0;
    o.detected_frames_percent = r1((100 * det) / (m.contact - m.lo + 1));
    for (const k of keys) {
      const seg = rows.slice(m.lo, m.contact + 1).map((r) => r[`${k}_deg`]).filter(isNum);
      const mx = seg.length ? Math.max(...seg) : NaN, mn = seg.length ? Math.min(...seg) : NaN;
      o[`${k}_at_liftoff_deg`] = r1(rows[m.lo][`${k}_deg`]);
      o[`${k}_at_contact_deg`] = r1(rows[m.contact][`${k}_deg`]);
      o[`${k}_max_deg`] = r1(mx); o[`${k}_min_deg`] = r1(mn); o[`${k}_range_deg`] = r1(mx - mn);
    }
    return o;
  };
  const steps = [], others = [];
  for (const m of moves) (m.sign === wantSign ? steps : others).push(m);
  const stepRows = steps.map((m, i) => mk(m, i + 1)), otherRows = others.map((m, i) => mk(m, i + 1));
  if (!stepRows.length) warnings.push(`${p.stepDir === "backward" ? "後方" : "前方"}へのステップを検出できませんでした。体の向き・ステップの方向・基準足の設定を確認してください。`);

  // ---- フレーム別：足の前後位置（換算区間の位置を0、前方＋） ----
  for (const s of SIDES) for (const j of ["heel", "ankle"]) {
    const ref = calib ? avgX(s, j, calib.a, calib.b) : NaN;
    rows.forEach((r, i) => { const x = at(s, j, i); r[`${s}_${j}_forward_cm`] = scale && isNum(x) && isNum(ref) ? r1((x - ref) * facing * scale) : null; });
  }
  rows.forEach((r) => (r.phase = ""));
  if (calib) for (let i = calib.a; i <= calib.b; i++) rows[i].phase = "換算区間";
  steps.forEach((m, k) => { for (let i = m.lo; i <= m.contact; i++) rows[i].phase = `ステップ${k + 1}`; });
  others.forEach((m, k) => { for (let i = m.lo; i <= m.contact; i++) if (!rows[i].phase) rows[i].phase = `反対方向${k + 1}`; });

  return { rows, steps: stepRows, others: otherRows, stepFrames: steps, otherFrames: others, calib, summary: summarize(stepRows), warnings, legMed };
}

// 平均・SD・左右差
export function summarize(list) {
  if (!list.length) return null;
  const out = [];
  const add = (label, key, unit) => {
    const v = list.map((s) => s[key]);
    out.push({ item: label, key, unit, n: v.filter(isNum).length, mean: round(mean(v), 2), sd: round(sd(v), 2), min: round(Math.min(...v.filter(isNum)), 2), max: round(Math.max(...v.filter(isNum)), 2) });
  };
  add("ステップ距離（踵）", "heel_distance_cm", "cm");
  add("ステップ距離（足関節）", "ankle_distance_cm", "cm");
  add("ステップ距離（踵）／下肢長", "heel_distance_percent_leg", "%");
  add("ステップ距離（足関節）／下肢長", "ankle_distance_percent_leg", "%");
  add("ステップ時間", "step_time_seconds", "秒");
  for (const [j, name] of [["hip_flexion", "股関節"], ["knee_flexion", "膝"], ["ankle_dorsiflexion", "足関節"]]) for (const s of SIDES) {
    add(`${sideJ(s)}${name} 最大`, `${s}_${j}_max_deg`, "度");
    add(`${sideJ(s)}${name} 最小`, `${s}_${j}_min_deg`, "度");
    add(`${sideJ(s)}${name} 可動範囲`, `${s}_${j}_range_deg`, "度");
  }
  add("体幹の傾き 最大", "trunk_tilt_max_deg", "度");
  add("体幹の傾き 最小", "trunk_tilt_min_deg", "度");
  add("体幹の傾き 接地時", "trunk_tilt_at_contact_deg", "度");
  return out;
}
// 左右差（右−左）：各ステップの値の平均の差
export function lrDiff(list) {
  if (!list.length) return [];
  const out = [];
  for (const [j, name] of [["hip_flexion", "股関節"], ["knee_flexion", "膝"], ["ankle_dorsiflexion", "足関節"]]) for (const [a, lab] of [["max", "最大"], ["min", "最小"], ["range", "可動範囲"]]) {
    const R = mean(list.map((s) => s[`right_${j}_${a}_deg`])), L = mean(list.map((s) => s[`left_${j}_${a}_deg`]));
    out.push({ item: `${name} ${lab}`, right: round(R, 2), left: round(L, 2), right_minus_left: round(R - L, 2) });
  }
  return out;
}

export function frameColumns() {
  const c = ["frame", "time_seconds", "phase", "detected"];
  for (const s of SIDES) for (const j of JOINTS) c.push(`${s}_${j}_x_px`, `${s}_${j}_y_px`, `${s}_${j}_visibility`);
  for (const s of SIDES) c.push(`${s}_hip_flexion_deg`, `${s}_knee_flexion_deg`, `${s}_ankle_dorsiflexion_deg`);
  c.push("trunk_tilt_deg");
  for (const s of SIDES) c.push(`${s}_leg_px`, `${s}_heel_forward_cm`, `${s}_ankle_forward_cm`);
  return c;
}
export const STEP_COLUMNS = (() => {
  const c = ["step", "direction", "step_side", "stance_side", "liftoff_frame", "liftoff_time_seconds", "contact_frame", "contact_time_seconds", "step_time_seconds", "contact_detected_by"];
  for (const j of ["heel", "ankle"]) c.push(`${j}_displacement_px`, `${j}_distance_cm`, `${j}_distance_percent_leg`, `${j}_distance_cm_by_left_leg`, `${j}_distance_cm_by_right_leg`);
  c.push("leg_length_cm", "calib_start_seconds", "calib_end_seconds", "calib_method", "leg_px_mean", "scale_cm_per_px", "detected_frames_percent");
  const keys = [];
  for (const s of SIDES) for (const j of ["hip_flexion", "knee_flexion", "ankle_dorsiflexion"]) keys.push(`${s}_${j}`);
  keys.push("trunk_tilt");
  for (const k of keys) for (const a of ["at_liftoff", "at_contact", "max", "min", "range"]) c.push(`${k}_${a}_deg`);
  return c;
})();
export const CALIB_COLUMNS = ["method", "start_seconds", "end_seconds", "leg_length_cm", "leg_px_left", "leg_px_right", "leg_px_mean", "scale_mean", "scale_left", "scale_right", "knee_left_deg", "knee_right_deg"];

export function notesTable(p, calib) {
  const d = p.stepDir === "backward" ? "後方" : "前方";
  return [
    ["内容", ENGINE_NOTE],
    ["条件", `体の向き: 画面上で${p.facing > 0 ? "右" : "左"}向き。ステップの方向: ${d}。基準足（支持側）: ${sideJ(p.refSide)}。踏み出す足: ${sideJ(p.stepSide)}。`],
    ["対象者", "体の向きの側（前側）にいる人を対象者とし、フレームをまたいで追跡。候補が近くに複数あるとき（介助者と重なったとき）は前側の人を優先。タップで指定した場合は、その場面から次の指定の手前まで、指定した人を追跡。見えないフレームは別の人に乗り換えず空欄。"],
    ["1回のステップ", "踏み出す足（踵と足関節の平均）の水平位置が、下肢長(px)の25%/秒を超える速さで動いた区間を検出し、前後に動き出し（10%/秒超）を含めて広げた始まりを離地とした。踏み出した後、踵の上下座標が床の高さ（動きが止まってから0.3秒間の中央値）に最初に戻ったフレームを接地とした。座標は移動平均で平滑化。"],
    ["ステップ距離", "踏み出した足の踵・足関節それぞれの、離地直前（3フレーム平均）から接地時（3フレーム平均）までの水平方向の移動量×換算係数。下肢長に対する割合も出力。"],
    ["換算係数", `換算係数(cm/px)＝下肢長（転子果長, ${p.legCm || "未入力"} cm）÷動画内の下肢長（股関節の点〜足関節の点の距離, px）。換算区間の左右の下肢の平均から求めた値を使用（左右それぞれの値も出力）。換算区間: ${calib ? `${calib.start_seconds}〜${calib.end_seconds}秒（${calib.method}）` : "なし"}。`],
    ["換算区間の自動検出", `両足首と骨盤が静止（下肢長の${CALIB.stillRatio * 100}%/秒未満）、左右の膝の屈曲が${CALIB.kneeMaxDeg}度未満、前方ステップでは基準足が前・後方ステップでは踏み出す足が前（膝も同じ前後関係）の状態が${CALIB.minSec}秒以上続く区間。最初のステップより前の区間を優先。見つからない場合は条件をゆるめて検出。`],
    ["角度の定義", "股関節：体幹線（肩→股関節の延長）に対する大腿の角度（屈曲＋・伸展−）。膝：大腿と下腿のなす角から求めた屈曲角（伸展位≈0）。足関節：下腿と足部（踵→つま先）のなす角−90度（背屈＋・底屈−）。体幹の傾き：股関節の中点→肩の中点の鉛直に対する角度（体の向きの側への前傾＋）。"],
    ["左右差", "右−左。各ステップの値の平均の差。"],
    ["欠損値", `ランドマークが見えない、または可視性が${VISIBILITY_THRESHOLD}未満の場合は空欄`],
    ["座標", "画像左上が(0,0)、右下方向へ値が増加（px）。足の前後位置（*_forward_cm）は換算区間の位置を0とし、体の向きの側を＋とした。"],
    ["注意", "カメラが進行方向に対して直角でないと距離・角度に誤差が出ます。股関節の推定点は大転子より下・内側にあり、転子果長とは一致しないため、換算には誤差が含まれます。真横からの単眼動画による2D推定であり、臨床測定・診断には使用できません。"],
  ];
}
