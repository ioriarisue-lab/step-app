import { PoseLandmarker } from "./vision_bundle.mjs";
import { Muxer, ArrayBufferTarget } from "./mp4-muxer.mjs";
import * as G from "./step.js";
import { RTMPoseEstimator } from "./rtm.js";

const APP_VERSION = "1.0.1";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- IndexedDB（歩行角度解析アプリとは別の保存場所） ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open("step-app", 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore("videos", { keyPath: "id" });
    db.createObjectStore("results", { keyPath: "id" });
    db.createObjectStore("kv");
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("保存に失敗しました（容量不足の可能性）"));
  });
}
const dbPut = (s, v, k) => tx(s, "readwrite", (o) => o.put(v, k));
const dbGet = (s, k) => tx(s, "readonly", (o) => o.get(k));
const dbDel = (s, k) => tx(s, "readwrite", (o) => o.delete(k));
const dbAll = (s) => tx(s, "readonly", (o) => o.getAll());
const lsGet = (k, d) => { try { return localStorage.getItem("step_" + k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem("step_" + k, v); } catch {} };

// ---------- 共通UI ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const fmtDate = (t) => new Date(t).toLocaleString("ja-JP");
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f1 = (v) => (v == null || !Number.isFinite(Number(v)) ? "-" : Number(v).toFixed(1));
const f2 = (v) => (v == null || !Number.isFinite(Number(v)) ? "-" : Number(v).toFixed(2));
const sideJ = G.sideJ;

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
async function saveFiles(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}
function bindSeg(sel, attr, init, onChange) {
  $$(`${sel} button`).forEach((b) => {
    b.classList.toggle("active", b.dataset[attr] === String(init));
    b.addEventListener("click", () => {
      $$(`${sel} button`).forEach((x) => x.classList.toggle("active", x === b));
      onChange(b.dataset[attr]);
    });
  });
}

// ---------- タブ ----------
$$(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name !== "record" && !recorder) stopCamera();
  if (name === "library") renderVideos();
  if (name === "results") renderResults();
  if (name === "settings") renderSettings();
}

// ---------- 撮影 ----------
let stream = null, recorder = null, chunks = [], recStart = 0, recTick = null;
async function startCamera() {
  stopCamera();
  const h = Number($("#resSel").value), w = h === 1080 ? 1920 : 1280;
  const fps = Number($("#fpsSel").value);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: $("#facingSel").value, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } },
    });
  } catch (e) { $("#camMsg").textContent = "カメラを使えません: " + e.message; return; }
  $("#preview").srcObject = stream;
  $("#preview").onloadedmetadata = () => fitPreview();
  $("#camMsg").classList.add("hidden");
  $("#recBtn").disabled = false;
  $("#camBtn").textContent = "カメラ再起動";
  const s = stream.getVideoTracks()[0].getSettings();
  toast(`カメラ: ${s.width}×${s.height} / ${Math.round(s.frameRate || fps)} fps`);
  if ($("#liveChk").checked) startLive();
}

// リアルタイム骨格表示（体の向きの側の人を追跡）
let liveFace = Number(lsGet("face", "1")), liveFrameNo = 0, liveTarget = null;
bindSeg("#liveFaceSeg", "face", liveFace, (v) => { liveFace = Number(v); lsSet("face", v); newLiveTarget(); });
function newLiveTarget() { const v = $("#preview"); liveTarget = new G.TargetTracker(v.videoWidth || 1920, v.videoHeight || 1080, 15); }
$(".camwrap").addEventListener("click", (e) => {
  if (!liveOn) return;
  const p = videoPointFromEvent($("#preview"), e);
  if (!p) return;
  const v = $("#preview");
  if (!liveTarget || liveTarget.w !== v.videoWidth) newLiveTarget();
  liveTarget.seedPoint(p[0] * v.videoWidth, p[1] * v.videoHeight);
  toast("タップした人を追跡します");
});
let liveLastPose = null, liveLm = null, liveOn = false, liveLastTs = 0, liveFrames = 0, liveFpsT = 0;
$("#liveChk").addEventListener("change", (e) => { if (e.target.checked) startLive(); else { $("#saveSkel").checked = false; stopLive(); } });
$("#saveSkel").addEventListener("change", (e) => { if (e.target.checked && !$("#liveChk").checked) { $("#liveChk").checked = true; startLive(); } });
async function startLive() {
  if (!stream || liveOn) return;
  liveOn = true;
  if (!liveLm) {
    $("#liveFps").classList.remove("hidden"); $("#liveFps").textContent = "骨格モデル準備中…";
    try { liveLm = await createLandmarker(); }
    catch (e) { toast(e.message, 5000); liveOn = false; $("#liveChk").checked = false; $("#liveFps").classList.add("hidden"); return; }
  }
  if (!liveOn || !stream) return;
  $("#liveFps").classList.remove("hidden");
  liveFrames = 0; liveFpsT = performance.now();
  const v = $("#preview");
  const next = (cb) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(cb) : requestAnimationFrame(cb));
  const step = () => {
    if (!liveOn || !stream) return;
    try {
      if (v.readyState >= 2 && v.videoWidth) {
        const ts = Math.max(performance.now(), liveLastTs + 1);
        liveLastTs = ts;
        const res = liveLm.detectForVideo(v, ts);
        if (!liveTarget || liveTarget.w !== v.videoWidth || liveTarget.h !== v.videoHeight) newLiveTarget();
        liveLastPose = liveTarget.step(res.landmarks || [], liveFrameNo++, liveFace);
        drawLive(liveLastPose, v.videoWidth, v.videoHeight);
        liveFrames++;
        const now = performance.now();
        if (now - liveFpsT > 1000) { $("#liveFps").textContent = `骨格 ${Math.round((liveFrames * 1000) / (now - liveFpsT))} fps`; liveFrames = 0; liveFpsT = now; }
      }
    } catch (e) { console.warn(e); }
    next(step);
  };
  next(step);
}
function stopLive() {
  liveOn = false; liveLastPose = null;
  const c = $("#liveCanvas"); c.getContext("2d").clearRect(0, 0, c.width, c.height);
  $("#liveFps").classList.add("hidden");
}
function drawLive(pose, W, H) {
  const c = $("#liveCanvas");
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  drawSkeleton(ctx, pose, W, H);
}
function drawSkeleton(ctx, pose, W, H, color = "rgb(80,230,70)", dot = "rgb(255,80,30)", scale = null) {
  if (!pose) return;
  const k = scale ?? Math.max(1, W / 640);
  const xy = {};
  pose.forEach((lm, i) => { if ((lm.visibility ?? 1) >= G.VISIBILITY_THRESHOLD) xy[i] = [lm.x * W, lm.y * H]; });
  ctx.lineCap = "round"; ctx.lineWidth = 3 * k; ctx.strokeStyle = color;
  for (const [a, b] of G.SKELETON_CONNECTIONS) if (xy[a] && xy[b]) { ctx.beginPath(); ctx.moveTo(...xy[a]); ctx.lineTo(...xy[b]); ctx.stroke(); }
  ctx.fillStyle = dot;
  for (const p of Object.values(xy)) { ctx.beginPath(); ctx.arc(p[0], p[1], 4 * k, 0, Math.PI * 2); ctx.fill(); }
}
function fitPreview() {
  const v = $("#preview"), w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return;
  $(".camwrap").style.aspectRatio = `${w} / ${h}`;
  $("#orientWarn").classList.toggle("hidden", w >= h);
}
$("#preview").addEventListener("resize", fitPreview);
window.addEventListener("orientationchange", () => setTimeout(() => stream && !recorder && startCamera(), 600));
function stopCamera() {
  stopLive();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; $("#preview").srcObject = null;
  $("#camMsg").classList.remove("hidden"); $("#camMsg").textContent = "「カメラ起動」を押してください";
  $("#recBtn").disabled = true; $("#camBtn").textContent = "カメラ起動";
}
$("#camBtn").onclick = startCamera;
["#resSel", "#fpsSel", "#facingSel"].forEach((s) => $(s).addEventListener("change", () => stream && !recorder && startCamera()));

function pickMime() {
  const list = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}
let skelRec = null, skelChunks = [], compLoopOn = false;
function makeRecorder(src, mimeType, store, onDone) {
  const r = new MediaRecorder(src, { mimeType, videoBitsPerSecond: 12_000_000 });
  r.ondataavailable = (e) => e.data.size && store.push(e.data);
  r.onstop = () => onDone(new Blob(store, { type: r.mimeType || mimeType || "video/mp4" }));
  return r;
}
$("#recBtn").onclick = async () => {
  if (recorder) { recorder.stop(); if (skelRec) skelRec.stop(); return; }
  if (!stream) return;
  const mimeType = pickMime();
  const name = `step_${stamp()}`;
  const fpsSet = stream.getVideoTracks()[0].getSettings().frameRate;
  const ext = (t) => (t.includes("webm") ? "webm" : "mp4");
  let pending = 1;
  const finish = () => {
    if (--pending > 0) return;
    clearInterval(recTick); $("#recTimer").classList.add("hidden");
    $("#recBtn").textContent = "録画開始"; keepAwake(false);
    toast("端末内に保存しました（「動画」タブ）");
  };
  chunks = [];
  recorder = makeRecorder(stream, mimeType, chunks, async (blob) => {
    recorder = null;
    await addVideo(blob, `${name}.${ext(blob.type)}`, fpsSet ? Math.round(fpsSet) : null, false, liveFace);
    finish();
  });
  if ($("#saveSkel").checked) {
    $("#liveChk").checked = true;
    await startLive();
    const v = $("#preview"), comp = document.createElement("canvas");
    comp.width = v.videoWidth; comp.height = v.videoHeight;
    const cx = comp.getContext("2d");
    compLoopOn = true;
    const draw = () => {
      if (!compLoopOn) return;
      if (v.videoWidth) { cx.drawImage(v, 0, 0, comp.width, comp.height); drawSkeleton(cx, liveLastPose, comp.width, comp.height); }
      requestAnimationFrame(draw);
    };
    draw();
    try {
      skelChunks = [];
      skelRec = makeRecorder(comp.captureStream(Math.round(fpsSet || 30)), mimeType, skelChunks, async (blob) => {
        compLoopOn = false; skelRec = null;
        await addVideo(blob, `${name}_skeleton.${ext(blob.type)}`, fpsSet ? Math.round(fpsSet) : null, true, liveFace);
        finish();
      });
      pending = 2;
    } catch (e) { compLoopOn = false; skelRec = null; toast("骨格入り動画を録画できません: " + e.message, 4000); }
  }
  recorder.start(1000);
  if (skelRec) skelRec.start(1000);
  recStart = Date.now(); keepAwake(true);
  $("#recBtn").textContent = "録画停止";
  $("#recTimer").classList.remove("hidden");
  recTick = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("#recTimer").textContent = `● ${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }, 250);
};

// ---------- 動画ライブラリ ----------
function loadVideoEl(blob, attach = false) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.setAttribute("playsinline", "");
    if (attach) { Object.assign(v.style, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none" }); document.body.appendChild(v); }
    v.onloadedmetadata = async () => {
      if (!Number.isFinite(v.duration)) {
        await new Promise((r) => { v.ontimeupdate = () => { v.ontimeupdate = null; r(); }; v.currentTime = 1e9; });
      }
      res(v);
    };
    v.onerror = () => rej(new Error("動画を開けません。MP4/MOV形式をお試しください。"));
    v.src = URL.createObjectURL(blob);
  });
}
function seekTo(v, t) {
  return new Promise((res) => {
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done);
    v.currentTime = t;
  });
}
function disposeVideo(v) { URL.revokeObjectURL(v.src); v.removeAttribute("src"); v.load(); v.remove(); }
async function makeThumb(blob) {
  try {
    const v = await loadVideoEl(blob, true);
    await seekTo(v, Math.min(0.2, v.duration / 2));
    const c = document.createElement("canvas"); c.width = 320; c.height = Math.round(320 * v.videoHeight / v.videoWidth) || 180;
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const meta = { thumb: c.toDataURL("image/jpeg", 0.7), duration: v.duration, width: v.videoWidth, height: v.videoHeight };
    disposeVideo(v); return meta;
  } catch { return {}; }
}
async function addVideo(blob, name, fps, skeleton = false, face = null) {
  const meta = await makeThumb(blob);
  await dbPut("videos", { id: uid(), name, created: Date.now(), type: blob.type, size: blob.size, blob, fps, skeleton, face, ...meta });
  renderVideos();
}
$("#importVideo").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  toast("読み込み中…");
  await addVideo(f, f.name, null);
  toast("端末内に保存しました");
};
async function renderVideos() {
  const list = (await dbAll("videos")).sort((a, b) => b.created - a.created);
  const ul = $("#videoList");
  if (!list.length) { ul.innerHTML = `<li class="empty">動画がありません。「撮影」タブで録画するか、読み込んでください。</li>`; return; }
  ul.innerHTML = list.map((v) => `
    <li data-id="${v.id}">
      ${v.thumb ? `<img class="thumb" src="${v.thumb}">` : `<div class="thumb"></div>`}
      <div class="meta"><b>${esc(v.name)}${v.skeleton ? ' <span class="tag">骨格入り</span>' : ""}</b>
        <span>${fmtDate(v.created)} ・ ${v.duration ? v.duration.toFixed(1) + " 秒" : ""} ・ ${v.width ? v.width + "×" + v.height : ""} ・ ${fmtSize(v.size)}${v.fps ? " ・ " + v.fps + " fps" : ""}</span></div>
      <div class="acts">
        ${v.skeleton ? "" : `<button class="btn small" data-act="analyze">解析</button>`}
        <button class="btn small sub" data-act="export">保存/共有</button>
        <button class="btn small sub" data-act="delete">削除</button>
      </div>
    </li>`).join("");
}
$("#videoList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest("li").dataset.id;
  const rec = await dbGet("videos", id);
  if (b.dataset.act === "analyze") openAnalyze(rec);
  if (b.dataset.act === "export") saveFiles([new File([rec.blob], rec.name, { type: rec.type })]);
  if (b.dataset.act === "delete" && confirm(`「${rec.name}」を削除しますか？`)) { await dbDel("videos", id); renderVideos(); }
});

// ---------- モデル ----------
let modelBytes = null;
async function getModel() {
  if (modelBytes) return modelBytes;
  const saved = await dbGet("kv", "model");
  if (saved) return (modelBytes = new Uint8Array(saved.buffer));
  for (const name of ["pose_landmarker_heavy.task", "pose_landmarker_full.task"]) {
    const buf = await fetchWithParts(name);
    if (buf && buf.byteLength > 1e6) { await dbPut("kv", { name, buffer: buf, size: buf.byteLength }, "model"); return (modelBytes = new Uint8Array(buf)); }
  }
  return null;
}
// 選んだファイルを読む。分割ファイル（.part1, .part2, …）は番号順につなぐ
async function readPicked(fileList) {
  const files = [...fileList];
  if (!files.length) return null;
  const partNo = (f) => { const m = f.name.match(/\.part(\d+)$/i); return m ? Number(m[1]) : null; };
  const parts = files.filter((f) => partNo(f) != null);
  if (!parts.length) { const f = files[0]; return { name: f.name, buffer: await f.arrayBuffer() }; }
  parts.sort((a, b) => partNo(a) - partNo(b));
  const nums = parts.map(partNo);
  if (nums[0] !== 1 || nums.some((n, i) => n !== i + 1)) throw new Error(`分割ファイルがそろっていません（選んだもの: ${nums.map((n) => ".part" + n).join("・")}）。.part1から順に、すべて同時に選んでください。`);
  const bufs = await Promise.all(parts.map((f) => f.arrayBuffer()));
  const u = new Uint8Array(bufs.reduce((t, b) => t + b.byteLength, 0));
  let o = 0; for (const b of bufs) { u.set(new Uint8Array(b), o); o += b.byteLength; }
  return { name: parts[0].name.replace(/\.part\d+$/i, ""), buffer: u.buffer, nParts: parts.length };
}
$("#importModel").onchange = async (e) => {
  const fl = e.target.files;
  let got;
  try { got = await readPicked(fl); } catch (err) { toast(err.message, 6000); e.target.value = ""; return; }
  e.target.value = "";
  if (!got) return;
  if (got.buffer.byteLength < 1e6) { toast("モデルファイルではないようです"); return; }
  if (got.nParts === 1 && /heavy|full/i.test(got.name)) { toast("分割ファイルが1つだけです。.part1と.part2を同時に選んでください。", 6000); return; }
  await dbPut("kv", { name: got.name, buffer: got.buffer, size: got.buffer.byteLength }, "model");
  modelBytes = new Uint8Array(got.buffer);
  toast("モデルを端末内に保存しました"); renderSettings(); updBadge();
};
$("#delModel").onclick = async () => {
  if (!confirm("このモデルを端末から削除しますか？（GitHubにモデルを置いている場合は、次の起動時に自動で読み込みます）")) return;
  await dbDel("kv", "model"); modelBytes = null; liveLm = null; renderSettings(); updBadge();
  const m = await getModel();
  toast(m ? "GitHubに置いたモデルを読み込みました" : "削除しました");
  renderSettings(); updBadge();
};
$("#splitModel").onclick = async () => {
  const m = await dbGet("kv", "model");
  if (!m) { toast("先にモデルを取り込んでください"); return; }
  const half = Math.ceil(m.buffer.byteLength / 2);
  const base = /full/i.test(m.name) ? "pose_landmarker_full.task" : "pose_landmarker_heavy.task";
  await saveFiles([1, 2].map((i) => new File([m.buffer.slice((i - 1) * half, i * half)], `${base}.part${i}`, { type: "application/octet-stream" })));
};
const RTM_FILES = { rtm_det: "rtm_det.onnx", rtm_pose: "rtm_pose.onnx" };
async function renderSettings() {
  const m = await dbGet("kv", "model");
  $("#modelStatus").innerHTML = m ? `保存済み: <b>${esc(m.name)}</b>（${fmtSize(m.size)}）` : `<span class="warn">未設定です。解析前にモデルを取り込んでください。</span>`;
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $("#storageInfo").textContent = `使用 ${fmtSize(e.usage || 0)} / 上限目安 ${fmtSize(e.quota || 0)}${p ? "（消去されにくい保存）" : ""}`;
  }
  $("#verInfo").textContent = `バージョン ${APP_VERSION}`;
  for (const k of ["rtm_det", "rtm_pose"]) {
    const x = await dbGet("kv", k);
    $(`#${k}Status`).innerHTML = x ? `保存済み: <b>${esc(x.name)}</b>（${fmtSize(x.size)}）` : "未設定";
  }
  $("#rtmPref").value = lsGet("rtm_pref", "auto");
  const subs = await getSubjects(), ids = Object.keys(subs).sort();
  $("#subjectList").innerHTML = ids.length ? ids.map((id) => `<li data-id="${esc(id)}"><div class="meta"><b>${esc(id)}</b><span>転子果長 ${subs[id].legCm} cm ・ ${fmtDate(subs[id].updated)}</span></div><div class="acts"><button class="btn small sub" data-act="delsub">削除</button></div></li>`).join("") : `<li class="empty">まだありません（解析設定で入力すると保存されます）</li>`;
}
$("#subjectList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act=delsub]"); if (!b) return;
  const id = b.closest("li").dataset.id;
  if (!confirm(`対象者「${id}」の下肢長を削除しますか？`)) return;
  const subs = await getSubjects(); delete subs[id]; await dbPut("kv", subs, "subjects"); renderSettings();
});
for (const k of ["rtm_det", "rtm_pose"]) {
  $(`#${k}Import`).onchange = async (e) => {
    let got;
    try { got = await readPicked(e.target.files); } catch (err) { toast(err.message, 6000); e.target.value = ""; return; }
    e.target.value = "";
    if (!got) return;
    const buf = got.buffer;
    if (buf.byteLength < 1e5) { toast("ONNXモデルではないようです"); return; }
    await dbPut("kv", { name: got.name, buffer: buf, size: buf.byteLength }, k);
    toast("モデルを端末内に保存しました"); renderSettings();
  };
  $(`#${k}Split`).onclick = async () => {
    const m = await dbGet("kv", k);
    if (!m) { toast("先にモデルを取り込んでください"); return; }
    const size = 24 * 1024 * 1024, n = Math.ceil(m.buffer.byteLength / size);
    await saveFiles(Array.from({ length: n }, (_, i) => new File([m.buffer.slice(i * size, (i + 1) * size)], `${RTM_FILES[k]}.part${i + 1}`, { type: "application/octet-stream" })));
  };
  $(`#${k}Del`).onclick = async () => { if (confirm("このモデルを端末から削除しますか？")) { await dbDel("kv", k); renderSettings(); } };
}
$("#rtmPref").onchange = (e) => lsSet("rtm_pref", e.target.value);
async function fetchWithParts(name) {
  try { const r = await fetch(name, { cache: "no-store" }); if (r.ok) return await r.arrayBuffer(); } catch {}
  const parts = [];
  for (let i = 1; i <= 12; i++) {
    try { const r = await fetch(`${name}.part${i}`, { cache: "no-store" }); if (!r.ok) break; parts.push(new Uint8Array(await r.arrayBuffer())); } catch { break; }
  }
  if (!parts.length) return null;
  const u = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0; for (const p of parts) { u.set(p, o); o += p.length; }
  return u.buffer;
}
async function getRtmModel(key) {
  const saved = await dbGet("kv", key);
  if (saved) return new Uint8Array(saved.buffer);
  const buf = await fetchWithParts(RTM_FILES[key]);
  if (buf && buf.byteLength > 1e5) { await dbPut("kv", { name: RTM_FILES[key], buffer: buf, size: buf.byteLength }, key); return new Uint8Array(buf); }
  return null;
}
async function createLandmarker(engine = "mediapipe") {
  if (window.__mockLm) return window.__mockLm(engine); // テスト用
  if (engine === "rtmpose") {
    const [det, pose] = await Promise.all([getRtmModel("rtm_det"), getRtmModel("rtm_pose")]);
    if (!det || !pose) throw new Error("RTMPoseのモデルが未設定です。「設定」タブで人物検出モデルと姿勢推定モデル（.onnx）を取り込んでください。");
    return await RTMPoseEstimator.create(det, pose, lsGet("rtm_pref", "auto"));
  }
  const bytes = await getModel();
  if (!bytes) throw new Error("姿勢推定モデルが未設定です。「設定」タブで pose_landmarker_heavy.task を取り込んでください。");
  const fileset = {
    wasmLoaderPath: new URL("vision_wasm_internal.js", location.href).href,
    wasmBinaryPath: new URL("vision_wasm_internal.wasm", location.href).href,
  };
  const opts = (delegate) => ({
    baseOptions: { modelAssetBuffer: bytes, delegate },
    runningMode: "VIDEO", numPoses: 3,
    minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.5,
  });
  try { return await PoseLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { return await PoseLandmarker.createFromOptions(fileset, opts("CPU")); }
}

// ---------- 対象者（下肢長） ----------
async function getSubjects() { return (await dbGet("kv", "subjects")) || {}; }
async function saveSubject(id, legCm) {
  if (!id || !(legCm > 0)) return;
  const subs = await getSubjects(); subs[id] = { legCm, updated: Date.now() }; await dbPut("kv", subs, "subjects");
}
async function fillSubjects() {
  const subs = await getSubjects();
  $("#subjDl").innerHTML = Object.keys(subs).sort().map((id) => `<option value="${esc(id)}">${esc(id)}（${subs[id].legCm} cm）</option>`).join("");
  return subs;
}
$("#subjId").addEventListener("input", async () => {
  const subs = await getSubjects(), s = subs[$("#subjId").value.trim()];
  if (s) $("#legCm").value = s.legCm;
});

// ---------- 解析ダイアログ ----------
let anaEngine = lsGet("engine", "mediapipe"), anaFace = Number(lsGet("face", "1")), anaDir = lsGet("dir", "forward"), anaRef = lsGet("ref", "right"), anaMove = lsGet("move", "other");
const updRefHint = () => {
  const step = anaMove === "same" ? anaRef : G.other(anaRef);
  $("#refHint").textContent = `${sideJ(step)}足を${anaDir === "backward" ? "後方" : "前方"}へ踏み出す動作を、離地から踵の接地まで1回として解析します（支持側は${sideJ(G.other(step))}足）。反対向きの動き（元の位置に戻す動きなど）は別の表に出します。`;
};
bindSeg("#engSeg", "eng", anaEngine, (v) => { anaEngine = v; lsSet("engine", v); closePickLm(); if (pickOn) detectPickFrame(); });
bindSeg("#faceSeg", "face", anaFace, (v) => { anaFace = Number(v); lsSet("face", v); drawPick(); });
bindSeg("#dirSeg", "dir", anaDir, (v) => { anaDir = v; lsSet("dir", v); updRefHint(); });
bindSeg("#refSeg", "ref", anaRef, (v) => { anaRef = v; lsSet("ref", v); updRefHint(); });
bindSeg("#moveSeg", "move", anaMove, (v) => { anaMove = v; lsSet("move", v); updRefHint(); });
updRefHint();

function videoPointFromEvent(video, e) { // object-fit: contain を考慮して動画内の位置（0〜1）に変換
  const r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const s = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
  const x = (e.clientX - r.left - ox) / (vw * s), y = (e.clientY - r.top - oy) / (vh * s);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : null;
}

// タップ指定：その場面の人をすべて骨格で表示し、番号つきで選べるようにする
let anaRec = null, anaSeeds = [], pickOn = false, pickLm = null, pickTs = 0, pickPoses = [], pickBusy = false, cancelFlag = false, running = false;
const PICK_COLORS = ["#ffb020", "#3fa9f5", "#e84393", "#7bd389", "#b388ff"];
async function closePickLm() { if (pickLm) { try { pickLm.close(); } catch {} pickLm = null; } }
async function detectPickFrame() {
  const v = $("#anaPreview");
  if (!pickOn || pickBusy || !v.videoWidth) return;
  pickBusy = true;
  try {
    $("#pickInfo").textContent = "この場面の人を検出中…";
    if (!pickLm) { G.setEngine(anaEngine); pickLm = await createLandmarker(anaEngine); }
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    pickTs += 1000;
    const res = await pickLm.detectForVideo(c, pickTs);
    pickPoses = res.landmarks || [];
    $("#pickInfo").textContent = pickPoses.length ? `${v.currentTime.toFixed(2)}秒：${pickPoses.length}人を検出。対象者の骨格をタップしてください（オレンジ枠＝自動で選ばれる前側の人）` : `${v.currentTime.toFixed(2)}秒：人を検出できませんでした。少し前後の場面に動かしてください`;
  } catch (e) { toast(e.message, 5000); setPick(false); }
  finally { pickBusy = false; drawPick(); }
}
function setPick(on) {
  pickOn = on;
  $("#pickCanvas").classList.toggle("active", on);
  $("#pickBtn").textContent = on ? "選ぶのをやめる" : "この場面の人を表示して選ぶ";
  $("#pickStep").classList.toggle("hidden", !on); $("#pickStep2").classList.toggle("hidden", !on);
  if (on) { $("#anaPreview").pause(); detectPickFrame(); }
  else { pickPoses = []; updSeedInfo(); drawPick(); }
}
$("#pickBtn").onclick = () => setPick(!pickOn);
for (const id of ["#pickStep", "#pickStep2"]) $(id).onclick = () => { const v = $("#anaPreview"); v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + 0.1 * Number($(id).dataset.d))); };
$("#anaPreview").addEventListener("seeked", () => { if (pickOn) detectPickFrame(); else drawPick(); });
$("#anaPreview").addEventListener("play", () => { if (pickOn) setPick(false); });
window.addEventListener("resize", () => { if (!$("#analyzeDlg").classList.contains("hidden")) drawPick(); });
function drawPick() {
  const c = $("#pickCanvas"), v = $("#anaPreview"), r = v.getBoundingClientRect();
  c.width = r.width; c.height = r.height;
  const g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
  if (!v.videoWidth) return;
  const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight), ox = (r.width - v.videoWidth * s) / 2, oy = (r.height - v.videoHeight * s) / 2;
  const W = v.videoWidth * s, H = v.videoHeight * s;
  g.save(); g.translate(ox, oy);
  if (pickOn && pickPoses.length) {
    const front = G.chooseFrontPose(pickPoses, v.videoWidth, v.videoHeight, anaFace);
    pickPoses.forEach((p, i) => {
      const col = PICK_COLORS[i % PICK_COLORS.length];
      drawSkeleton(g, p, W, H, col, col, 0.8);
      const xs = p.map((l) => l.x * W), ys = p.map((l) => l.y * H);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      g.lineWidth = p === front ? 3 : 1.5; g.strokeStyle = p === front ? "#ffb020" : "rgba(255,255,255,0.7)";
      g.setLineDash(p === front ? [] : [6, 4]); g.strokeRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12); g.setLineDash([]);
      g.fillStyle = col; g.beginPath(); g.arc(x0 + 4, y0 - 4, 14, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#000"; g.font = "bold 16px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(i + 1), x0 + 4, y0 - 4);
    });
  }
  // 指定済みの位置（今の場面に近いもの）
  for (const sd of anaSeeds) {
    if (Math.abs(sd.t - v.currentTime) > 0.06) continue;
    const x = sd.x * W, y = sd.y * H;
    g.strokeStyle = "#ffb020"; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 18, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(x - 26, y); g.lineTo(x + 26, y); g.moveTo(x, y - 26); g.lineTo(x, y + 26); g.stroke();
  }
  g.restore();
}
$("#pickCanvas").addEventListener("click", (e) => {
  const v = $("#anaPreview"), p = videoPointFromEvent(v, e);
  if (!p || !pickOn) return;
  const W = v.videoWidth, H = v.videoHeight;
  let x = p[0], y = p[1];
  if (pickPoses.length) {
    const hit = G.choosePoseAtPoint(pickPoses, W, H, x * W, y * H);
    if (!hit) { toast("骨格の上をタップしてください"); return; }
    const c = G.bodyCenter(hit, W, H); x = c[0] / W; y = c[1] / H; // 体幹の中心で指定する
  }
  anaSeeds = anaSeeds.filter((s) => Math.abs(s.t - v.currentTime) > 0.06);
  anaSeeds.push({ t: v.currentTime, x, y });
  anaSeeds.sort((a, b) => a.t - b.t);
  setPick(false);
  toast(`${v.currentTime.toFixed(2)}秒で対象者を指定しました`);
});
function updSeedInfo() {
  $("#pickClear").classList.toggle("hidden", !anaSeeds.length);
  if (!pickOn) $("#pickInfo").textContent = anaSeeds.length ? `${anaSeeds.length}か所で指定済み（各場面から、次の指定の手前まで、その人を追跡）` : "指定なし（体の向きの側＝前側の人を追跡）";
  $("#seedList").innerHTML = anaSeeds.map((s, i) => `<li><span data-go="${i}">${s.t.toFixed(2)}秒</span><button data-del="${i}" aria-label="削除">✕</button></li>`).join("");
}
$("#seedList").addEventListener("click", (e) => {
  const d = e.target.closest("[data-del]"), go = e.target.closest("[data-go]");
  if (d) { anaSeeds.splice(Number(d.dataset.del), 1); updSeedInfo(); drawPick(); }
  if (go) { $("#anaPreview").currentTime = anaSeeds[Number(go.dataset.go)].t; }
});
$("#pickClear").onclick = () => { anaSeeds = []; updSeedInfo(); drawPick(); };

async function openAnalyze(rec) {
  anaRec = rec;
  $("#anaName").textContent = rec.name;
  const pv = $("#anaPreview"); if (pv.src) URL.revokeObjectURL(pv.src);
  pv.src = URL.createObjectURL(rec.blob);
  $("#anaProgress").classList.add("hidden");
  $("#anaStart").disabled = false; $("#anaCancel").textContent = "閉じる";
  $("#anaFps").value = rec.fps || 30;
  anaSeeds = []; setPick(false); updSeedInfo();
  if (rec.face) { anaFace = rec.face; $$("#faceSeg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.face) === anaFace)); }
  const subs = await fillSubjects(), last = lsGet("subject", "");
  $("#subjId").value = last; $("#legCm").value = subs[last] ? subs[last].legCm : "";
  $("#analyzeDlg").classList.remove("hidden");
  if (!rec.fps) estimateFps(rec.blob).then((f) => { if (f && !running) $("#anaFps").value = f; });
}
async function estimateFps(blob) {
  try {
    const v = await loadVideoEl(blob, true);
    if (!v.requestVideoFrameCallback) { disposeVideo(v); return null; }
    const times = [];
    await new Promise((res) => {
      const to = setTimeout(res, 2500);
      const cb = (_, m) => { if (!times.length || m.mediaTime !== times[times.length - 1]) times.push(m.mediaTime); if (times.length > 20) { clearTimeout(to); res(); } else v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb); v.play().catch(res);
    });
    disposeVideo(v);
    const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0).sort((a, b) => a - b);
    if (d.length < 5) return null;
    const f = 1 / d[Math.floor(d.length / 2)];
    const common = [24, 25, 30, 50, 60, 120, 240].find((c) => Math.abs(f - c) / c < 0.04);
    return common || Math.round(f * 100) / 100;
  } catch { return null; }
}
function closeAnalyze() {
  if (running) { cancelFlag = true; return; }
  setPick(false); closePickLm();
  const pv = $("#anaPreview"); pv.pause(); URL.revokeObjectURL(pv.src); pv.removeAttribute("src"); pv.load();
  $("#analyzeDlg").classList.add("hidden");
}
$("#anaCancel").onclick = closeAnalyze;
$("#anaStart").onclick = async () => {
  const fps = Number($("#anaFps").value);
  if (!(fps > 0)) { toast("フレームレートを入力してください"); return; }
  const subject = $("#subjId").value.trim(), legCm = Number($("#legCm").value);
  if (!(legCm > 0) && !confirm("下肢長が未入力です。cmへの換算なし（px）で解析しますか？（あとから結果画面で入力できます）")) return;
  if (legCm > 0 && (legCm < 40 || legCm > 120) && !confirm(`下肢長 ${legCm} cm で合っていますか？`)) return;
  if (subject) { lsSet("subject", subject); await saveSubject(subject, legCm); }
  setPick(false); await closePickLm();
  $("#anaPreview").pause();
  running = true; cancelFlag = false;
  $("#anaStart").disabled = true; $("#anaCancel").textContent = "中止";
  $("#anaProgress").classList.remove("hidden");
  keepAwake(true);
  try {
    const stepSide = anaMove === "same" ? anaRef : G.other(anaRef);
    const params = { fps, facing: anaFace, stepDir: anaDir, refSide: anaRef, stepSide, legCm: legCm > 0 ? legCm : null, calibManual: null, engine: anaEngine, subject };
    const result = await analyze(anaRec, params, $("#anaStick").checked, anaSeeds, (i, n, msg) => {
      $("#anaBar").value = n ? i / n : 0;
      $("#anaText").textContent = msg || `${i} / ${n} フレーム`;
    });
    await dbPut("results", result);
    running = false; closeAnalyze();
    showTab("results"); openResult(result.id);
    toast("解析が完了しました");
  } catch (e) {
    running = false;
    console.error(e);
    $("#anaText").textContent = e.message === "cancel" ? "中止しました" : "エラー: " + e.message;
    $("#anaStart").disabled = false; $("#anaCancel").textContent = "閉じる";
  } finally { keepAwake(false); G.setEngine("mediapipe"); }
};

// ---------- 解析本体 ----------
function drawOverlay(ctx, pose, W, H, i, fps, label) {
  drawSkeleton(ctx, pose, W, H, "rgb(80,230,70)", "rgb(255,80,30)", 1);
  const text = `Frame: ${i}   Time: ${(i / fps).toFixed(2)} s${label ? "   " + label : ""}`;
  ctx.font = "bold 26px -apple-system, Helvetica, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = "#000"; ctx.fillRect(12, 12, tw + 24, 46);
  ctx.fillStyle = "#fff"; ctx.fillText(text, 24, 36);
}
async function setupEncoder(W, H, fps) {
  if (!("VideoEncoder" in window)) return null;
  const ew = W - (W % 2), eh = H - (H % 2);
  let cfg = null;
  for (const codec of ["avc1.640033", "avc1.640028", "avc1.4d0033", "avc1.42003e"]) {
    const c = { codec, width: ew, height: eh, bitrate: Math.min(16e6, ew * eh * fps * 0.12), framerate: fps, avc: { format: "avc" } };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch {}
  }
  if (!cfg) return null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "avc", width: ew, height: eh, frameRate: fps }, fastStart: "in-memory", firstTimestampBehavior: "offset" });
  let err = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (err = e) });
  enc.configure(cfg);
  let canvas = null;
  if (ew !== W || eh !== H) { canvas = document.createElement("canvas"); canvas.width = ew; canvas.height = eh; }
  return {
    async add(src, i) {
      if (err) throw err;
      let s = src;
      if (canvas) { canvas.getContext("2d").drawImage(src, 0, 0); s = canvas; }
      const frame = new VideoFrame(s, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
      frame.close();
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    },
    async finish() { await enc.flush(); enc.close(); muxer.finalize(); return new Blob([target.buffer], { type: "video/mp4" }); },
    abort() { try { enc.close(); } catch {} },
  };
}
const phaseLabel = (ph) => (ph === "換算区間" ? "CALIB" : ph.startsWith("ステップ") ? "STEP " + ph.slice(4) : ph.startsWith("反対方向") ? "RETURN " + ph.slice(4) : "");

async function analyze(rec, params, makeStick, seeds, progress) {
  const { fps, engine } = params;
  progress(0, 0, "モデルを準備中…");
  G.setEngine(engine);
  const landmarker = await createLandmarker(engine);
  const backendName = landmarker.backend || "";
  const v = await loadVideoEl(rec.blob, true);
  try { await v.play(); v.pause(); } catch {}
  const W = v.videoWidth, H = v.videoHeight, duration = v.duration;
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const enc = makeStick ? await setupEncoder(W, H, fps) : null;
  const total = Math.max(1, Math.floor(duration * fps + 1e-6));
  const cands = [];
  const t0 = performance.now();
  const frameTime = (i) => Math.min((i + 0.5) / fps, Math.max(0, duration - 0.001));
  let stick = null, track, comp;
  try {
    try {
      for (let i = 0; i < total; i++) {
        if (cancelFlag) throw new Error("cancel");
        await seekTo(v, frameTime(i));
        ctx.drawImage(v, 0, 0, W, H);
        const res = await landmarker.detectForVideo(canvas, Math.round((i * 1000) / fps));
        cands.push((res.landmarks || []).map((p) => p.map((l) => ({ x: l.x, y: l.y, z: l.z || 0, visibility: l.visibility }))));
        if (i % 3 === 0) {
          const el = (performance.now() - t0) / 1000, rem = (el / (i + 1)) * (total - i - 1) * (enc ? 1.15 : 1);
          progress(i + 1, total, `${i + 1} / ${total} フレーム ・ 残り約 ${Math.ceil(rem)} 秒`);
        }
      }
    } finally { landmarker.close(); }
    const sds = (seeds || []).map((s) => ({ frame: Math.floor(s.t * fps), x: s.x, y: s.y }));
    track = G.trackAll(cands, W, H, fps, params.facing, sds);
    var raw = track.sel.map((pose, i) => G.buildRow(i, fps, W, H, pose));
    comp = G.computeAll(raw, { ...params, W, H, thr: G.VISIBILITY_THRESHOLD });
    if (enc) {
      for (let i = 0; i < total; i++) {
        if (cancelFlag) throw new Error("cancel");
        await seekTo(v, frameTime(i));
        ctx.drawImage(v, 0, 0, W, H);
        drawOverlay(ctx, track.sel[i], W, H, i, fps, phaseLabel(comp.rows[i].phase));
        await enc.add(canvas, i);
        if (i % 5 === 0) progress(i + 1, total, `スティックピクチャー動画を作成中 ${i + 1} / ${total}`);
      }
      stick = await enc.finish();
    }
  } catch (e) { enc && enc.abort(); throw e; }
  finally { disposeVideo(v); }
  const trackInfo = { seeded: track.seeded, missing: track.sel.filter((p, i) => !p && cands[i].length).length, multi: cands.filter((c) => c.length > 1).length };
  const base = rec.name.replace(/\.[^.]+$/, "") + (engine === "rtmpose" ? "_rtmpose" : "") + "_step";
  return {
    id: uid(), videoId: rec.id, videoName: rec.name, base, created: Date.now(), engine, backendName, trackInfo,
    width: W, height: H, frames: raw.length, thr: G.VISIBILITY_THRESHOLD, params, raw, stick,
    nSteps: comp.steps.length, warnFlag: comp.warnings.length > 0,
    noStickWarn: makeStick && !enc,
  };
}
const calc = (r) => G.computeAll(r.raw, { ...r.params, W: r.width, H: r.height, thr: r.thr });

// ---------- 出力 ----------
const cell = (v) => (v == null || (typeof v === "number" && !Number.isFinite(v)) ? "" : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function toCSV(cols, rows) { return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n"; }
const csvBlob = (cols, rows) => new Blob(["﻿" + toCSV(cols, rows)], { type: "text/csv" });
function aoa(cols, objs) { return [cols, ...objs.map((o) => cols.map((c) => (o[c] == null || Number.isNaN(o[c]) ? null : o[c])))]; }
function calibRow(r, c) { return c ? { ...c, leg_length_cm: r.params.legCm } : { method: "なし", leg_length_cm: r.params.legCm }; }
function conditionRows(r) {
  const p = r.params;
  return [
    ["動画", r.videoName], ["解析日時", fmtDate(r.created)], ["対象者ID", p.subject || ""],
    ["解析エンジン", (r.engine === "rtmpose" ? "RTMPose（Halpe26）" : "MediaPipe Pose（heavy）") + (r.backendName ? `・${r.backendName}` : "")],
    ["フレーム数 / fps", `${r.frames} / ${p.fps}`], ["体の向き", p.facing > 0 ? "右向き" : "左向き"],
    ["ステップの方向", p.stepDir === "backward" ? "後方" : "前方"], ["基準足（支持側）", sideJ(p.refSide)], ["踏み出す足", sideJ(p.stepSide)],
    ["下肢長（転子果長）", p.legCm ? `${p.legCm} cm` : "未入力"],
    ["対象者の指定", r.trackInfo.seeded ? `タップで${r.trackInfo.seeded}か所指定` : "前側の人（自動）"],
  ];
}
function buildXlsx(r, c) {
  const X = window.XLSX, wb = X.utils.book_new();
  const add = (data, name) => X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(data), name);
  add(c.steps.length ? aoa(G.STEP_COLUMNS, c.steps) : [G.STEP_COLUMNS, ["ステップを検出できませんでした"]], "ステップ一覧");
  const scols = ["item", "unit", "n", "mean", "sd", "min", "max"];
  add(c.summary ? aoa(scols, c.summary) : [scols], "平均");
  add(aoa(["item", "right", "left", "right_minus_left"], G.lrDiff(c.steps)), "左右差");
  add(c.others.length ? aoa(G.STEP_COLUMNS, c.others) : [G.STEP_COLUMNS, ["なし"]], "反対方向の動き");
  add(aoa(G.CALIB_COLUMNS, [calibRow(r, c.calib)]), "換算係数");
  add(aoa(G.frameColumns(), c.rows), "フレーム別");
  add([["項目", "内容"], ...conditionRows(r), ...G.notesTable(r.params, c.calib), ...c.warnings.map((w) => ["警告", w])], "説明");
  const out = X.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
const canvasBlob = (cv) => new Promise((res) => cv.toBlob(res, "image/png"));

// グラフ：上=足の前後位置、中=股・膝、下=足関節・体幹。換算区間とステップを色付け
function drawGraph(r, c) {
  const Wc = 1920, Hc = 1600, cv = document.createElement("canvas"); cv.width = Wc; cv.height = Hc;
  const g = cv.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, Wc, Hc);
  const font = (s, b = "") => `${b} ${s}px "Hiragino Sans", -apple-system, sans-serif`;
  const rows = c.rows, fps = r.params.fps, xs = rows.map((x) => x.time_seconds), xmax = Math.max(1e-6, xs[xs.length - 1] || 1);
  const cm = !!(c.calib && c.calib.scale_mean);
  g.fillStyle = "#000"; g.textAlign = "center"; g.textBaseline = "middle"; g.font = font(34, "bold");
  g.fillText(`ステップ動作（${sideJ(r.params.stepSide)}足を${r.params.stepDir === "backward" ? "後方" : "前方"}へ）2D推定 — 臨床測定ではありません`, Wc / 2, 40);
  const footPx = (s, i) => { const x = rows[i][`${s}_heel_x_px`]; return Number.isFinite(x) ? (x - (rows[0][`${s}_heel_x_px`] ?? x)) * r.params.facing : null; };
  const panels = [
    { title: cm ? "踵の前後位置（換算区間の位置＝0、前方＋, cm）" : "踵の前後位置（px、前方＋）", unit: cm ? "cm" : "px",
      lines: [["左踵", "#1f77b4", (i) => (cm ? rows[i].left_heel_forward_cm : footPx("left", i))], ["右踵", "#ff7f0e", (i) => (cm ? rows[i].right_heel_forward_cm : footPx("right", i))]] },
    { title: "股関節・膝の角度（屈曲＋）", unit: "度",
      lines: [["左股", "#1f77b4", (i) => rows[i].left_hip_flexion_deg], ["右股", "#ff7f0e", (i) => rows[i].right_hip_flexion_deg], ["左膝", "#2ca02c", (i) => rows[i].left_knee_flexion_deg], ["右膝", "#d62728", (i) => rows[i].right_knee_flexion_deg]] },
    { title: "足関節（背屈＋）・体幹の傾き（前傾＋）", unit: "度",
      lines: [["左足関節", "#1f77b4", (i) => rows[i].left_ankle_dorsiflexion_deg], ["右足関節", "#ff7f0e", (i) => rows[i].right_ankle_dorsiflexion_deg], ["体幹", "#7f3fbf", (i) => rows[i].trunk_tilt_deg]] },
  ];
  const L = 150, R = Wc - 60, top0 = 130, ph = 380, gap = 110;
  panels.forEach((p, k) => {
    const T = top0 + k * (ph + gap), B = T + ph;
    const series = p.lines.map(([, , f]) => rows.map((_, i) => f(i)));
    const all = series.flat().filter((v) => v != null && Number.isFinite(v));
    let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 10;
    const padv = Math.max(2, (hi - lo) * 0.08); lo -= padv; hi += padv;
    const step = niceStep((hi - lo) / 6);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const X = (x) => L + ((R - L) * x) / xmax, Y = (y) => B - ((B - T) * (y - lo)) / (hi - lo);
    // 区間の色付け
    const band = (a, b, col) => { g.fillStyle = col; g.fillRect(X(a / fps), T, Math.max(2, X(b / fps) - X(a / fps)), B - T); };
    if (c.calib) band(c.calib.a, c.calib.b, "rgba(120,120,120,0.18)");
    c.stepFrames.forEach((m) => band(m.lo, m.contact, "rgba(43,79,138,0.16)"));
    c.otherFrames.forEach((m) => band(m.lo, m.contact, "rgba(255,160,40,0.14)"));
    g.font = font(28); g.fillStyle = "#000"; g.textAlign = "center"; g.fillText(p.title, (L + R) / 2, T - 26);
    g.strokeStyle = "rgba(0,0,0,0.12)"; g.lineWidth = 1.5; g.font = font(22); g.fillStyle = "#333";
    for (let y = lo; y <= hi + 1e-9; y += step) { g.beginPath(); g.moveTo(L, Y(y)); g.lineTo(R, Y(y)); g.stroke(); g.textAlign = "right"; g.fillText(String(Math.round(y * 100) / 100), L - 12, Y(y)); }
    const xstep = niceStep(xmax / 10);
    for (let x = 0; x <= xmax + 1e-9; x += xstep) { g.beginPath(); g.moveTo(X(x), T); g.lineTo(X(x), B); g.stroke(); g.textAlign = "center"; g.fillText(String(Math.round(x * 100) / 100), X(x), B + 24); }
    g.strokeStyle = "#000"; g.lineWidth = 2; g.strokeRect(L, T, R - L, B - T);
    g.save(); g.translate(48, (T + B) / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.font = font(24); g.fillStyle = "#000"; g.fillText(p.unit, 0, 0); g.restore();
    series.forEach((ys, si) => {
      g.strokeStyle = p.lines[si][1]; g.lineWidth = 3; g.beginPath(); let pen = false;
      ys.forEach((y, i) => { if (y == null || !Number.isFinite(y)) { pen = false; return; } if (!pen) { g.moveTo(X(xs[i]), Y(y)); pen = true; } else g.lineTo(X(xs[i]), Y(y)); });
      g.stroke();
    });
    if (k === 0) c.stepFrames.forEach((m, j) => { g.fillStyle = "#2b4f8a"; g.font = font(22, "bold"); g.textAlign = "center"; g.fillText(`S${j + 1}`, X(((m.lo + m.contact) / 2) / fps), T + 18); });
    const lw = 250, lh = 16 + p.lines.length * 34, lx = R - lw - 12, ly = T + 12;
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(lx, ly, lw, lh); g.strokeStyle = "#ccc"; g.lineWidth = 1; g.strokeRect(lx, ly, lw, lh);
    p.lines.forEach(([n, col], si) => {
      g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); g.moveTo(lx + 14, ly + 24 + si * 34); g.lineTo(lx + 60, ly + 24 + si * 34); g.stroke();
      g.fillStyle = "#000"; g.textAlign = "left"; g.font = font(22); g.fillText(n, lx + 72, ly + 24 + si * 34);
    });
  });
  g.textAlign = "center"; g.font = font(24); g.fillStyle = "#000";
  const yb = top0 + 3 * ph + 2 * gap + 70;
  g.fillText("時間（秒）　灰色＝換算区間　青＝ステップ（離地〜接地）　橙＝反対方向の動き", (L + R) / 2, yb);
  return cv;
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ---------- 結果 ----------
async function renderResults() {
  const list = (await dbAll("results")).sort((a, b) => b.created - a.created);
  const ul = $("#resultList");
  if (!list.length) { ul.innerHTML = `<li class="empty">解析結果はまだありません。</li>`; return; }
  ul.innerHTML = list.map((r) => `
    <li data-id="${r.id}">
      <div class="meta"><b>${esc(r.base)}</b>
        <span>${r.params.subject ? esc(r.params.subject) + " ・ " : ""}${r.params.stepDir === "backward" ? "後方" : "前方"} ・ ${fmtDate(r.created)} ・ ${r.nSteps}回${r.warnFlag ? " ・ ⚠" : ""}</span></div>
      <div class="acts">
        <button class="btn small" data-act="open">表示</button>
        <button class="btn small sub" data-act="delete">削除</button>
      </div>
    </li>`).join("");
}
$("#resultList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest("li").dataset.id;
  if (b.dataset.act === "open") openResult(id);
  if (b.dataset.act === "delete" && confirm("この解析結果を削除しますか？")) {
    await dbDel("results", id); $("#resultView").classList.add("hidden"); renderResults();
  }
});
let viewUrls = [];
function stepTable(list, title) {
  if (!list.length) return "";
  const M = list[0].step_side;
  return `<div class="tblwrap"><table class="cyc">
    <tr><th>${title}</th><th>離地(秒)</th><th>接地(秒)</th><th>時間(秒)</th><th>距離 踵(cm)</th><th>距離 足関節(cm)</th><th>踵/下肢長(%)</th><th>足関節/下肢長(%)</th><th>${sideJ(M)}股 最大</th><th>${sideJ(M)}膝 最大</th><th>${sideJ(M)}足関節 接地時</th><th>体幹 接地時</th></tr>
    ${list.map((s) => `<tr><td>${s.step}</td><td>${f2(s.liftoff_time_seconds)}</td><td>${f2(s.contact_time_seconds)}</td><td>${f2(s.step_time_seconds)}</td><td>${f1(s.heel_distance_cm)}</td><td>${f1(s.ankle_distance_cm)}</td><td>${f1(s.heel_distance_percent_leg)}</td><td>${f1(s.ankle_distance_percent_leg)}</td><td>${f1(s[`${M}_hip_flexion_max_deg`])}</td><td>${f1(s[`${M}_knee_flexion_max_deg`])}</td><td>${f1(s[`${M}_ankle_dorsiflexion_at_contact_deg`])}</td><td>${f1(s.trunk_tilt_at_contact_deg)}</td></tr>`).join("")}
  </table></div>`;
}
async function openResult(id) {
  const r = await dbGet("results", id);
  viewUrls.forEach(URL.revokeObjectURL); viewUrls = [];
  const u = (b) => { const x = URL.createObjectURL(b); viewUrls.push(x); return x; };
  G.setEngine(r.engine);
  const c = calc(r);
  const png = await canvasBlob(drawGraph(r, c));
  const cb = c.calib, d = r.params.stepDir === "backward" ? "後方" : "前方";
  const warns = [...c.warnings, ...(r.noStickWarn ? ["この端末ではスティックピクチャー動画を作成できませんでした（iOS / iPadOS 16.4以降が必要）。"] : [])];
  const sumKeys = ["heel_distance_cm", "ankle_distance_cm", "heel_distance_percent_leg", "ankle_distance_percent_leg", "step_time_seconds"];
  $("#resultView").innerHTML = `
    <h2 style="margin-top:0">${esc(r.base)}</h2>
    ${warns.length ? `<p class="warn">${warns.map(esc).join("<br>")}</p>` : ""}
    <table class="sum">${conditionRows(r).slice(0, 10).map(([a, b]) => `<tr><td>${a}</td><td>${esc(b)}</td></tr>`).join("")}
      <tr><td>追跡</td><td>${r.trackInfo.seeded ? `タップで${r.trackInfo.seeded}か所指定した人` : "体の向きの側（前側）の人"}・複数人が映ったフレーム ${r.trackInfo.multi}・対象者を確認できず空欄にしたフレーム ${r.trackInfo.missing}</td></tr>
    </table>
    <div class="calibbox">
      <b>換算係数</b>
      <p class="mono" style="margin:6px 0">${cb ? `区間 ${cb.start_seconds}〜${cb.end_seconds}秒（${esc(cb.method)}）<br>動画内の下肢長 左 ${f1(cb.leg_px_left)} px・右 ${f1(cb.leg_px_right)} px・平均 ${f1(cb.leg_px_mean)} px（膝の屈曲 左 ${f1(cb.knee_left_deg)}°・右 ${f1(cb.knee_right_deg)}°）<br>換算係数 平均 ${cb.scale_mean ? cb.scale_mean.toFixed(4) : "-"} cm/px（左 ${cb.scale_left ? cb.scale_left.toFixed(4) : "-"}・右 ${cb.scale_right ? cb.scale_right.toFixed(4) : "-"}）` : "換算区間なし"}</p>
      <div class="row">
        <label>区間の開始(秒)<input id="cbA" type="number" step="0.01" min="0" value="${cb ? cb.start_seconds : ""}"></label>
        <label>終了(秒)<input id="cbB" type="number" step="0.01" min="0" value="${cb ? cb.end_seconds : ""}"></label>
        <label>下肢長(cm)<input id="cbLeg" type="number" step="0.1" min="30" max="130" value="${r.params.legCm ?? ""}"></label>
        <button id="cbApply" class="btn small">この条件で再計算</button>
        ${r.params.calibManual ? `<button id="cbAuto" class="btn small sub">区間を自動に戻す</button>` : ""}
      </div>
      <p class="hint" style="margin:4px 0">膝を伸ばして静止して立っている場面を指定してください（スティックピクチャー動画や下のグラフの時間を参考に）。カメラが進行方向に対して直角でないと誤差が出ます。</p>
    </div>
    <h2>ステップ1回ごとの結果（${sideJ(r.params.stepSide)}足を${d}へ・${c.steps.length}回）</h2>
    ${stepTable(c.steps, "回") || `<p class="hint">検出できませんでした。</p>`}
    ${c.summary ? `<h2>平均（${c.steps.length}回）</h2><div class="tblwrap"><table class="cyc"><tr><th>項目</th><th>平均</th><th>SD</th><th>最小</th><th>最大</th></tr>
      ${c.summary.filter((s) => sumKeys.includes(s.key)).map((s) => `<tr><td style="text-align:left">${s.item}（${s.unit}）</td><td>${f2(s.mean)}</td><td>${f2(s.sd)}</td><td>${f2(s.min)}</td><td>${f2(s.max)}</td></tr>`).join("")}</table></div>
      <h2>左右差（ステップ中の角度、平均）</h2><div class="tblwrap"><table class="cyc"><tr><th>項目</th><th>右</th><th>左</th><th>右−左</th></tr>
      ${G.lrDiff(c.steps).map((s) => `<tr><td style="text-align:left">${s.item}（度）</td><td>${f1(s.right)}</td><td>${f1(s.left)}</td><td>${f1(s.right_minus_left)}</td></tr>`).join("")}</table></div>` : ""}
    ${c.others.length ? `<details><summary>反対方向の動き（${c.others.length}回）</summary>${stepTable(c.others, "回")}</details>` : ""}
    <img id="graphImg" src="${u(png)}" alt="グラフ">
    ${r.stick ? `<h2>スティックピクチャー動画</h2><video src="${u(r.stick)}" controls playsinline></video>` : ""}
    <div class="row">
      <button class="btn" data-f="all">すべて保存/共有</button>
      <button class="btn sub small" data-f="steps">ステップ一覧CSV</button>
      <button class="btn sub small" data-f="frames">フレーム別CSV</button>
      <button class="btn sub small" data-f="xlsx">Excel</button>
      <button class="btn sub small" data-f="png">グラフ</button>
      ${r.stick ? `<button class="btn sub small" data-f="stick">スティック動画</button>` : ""}
    </div>
    <p class="hint">「ファイルに保存」でファイルAppへ、動画は「ビデオを保存」で写真Appへ保存できます。ステップ一覧CSVとExcelには換算係数とその区間も記録されます。</p>`;
  $("#resultView").classList.remove("hidden");
  const files = () => {
    return {
      steps: new File([csvBlob(G.STEP_COLUMNS, c.steps)], `${r.base}_steps.csv`, { type: "text/csv" }),
      frames: new File([csvBlob(G.frameColumns(), c.rows)], `${r.base}_frames.csv`, { type: "text/csv" }),
      xlsx: new File([buildXlsx(r, c)], `${r.base}.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      png: new File([png], `${r.base}_graph.png`, { type: "image/png" }),
      ...(r.stick ? { stick: new File([r.stick], `${r.base}_stick_figure.mp4`, { type: "video/mp4" }) } : {}),
    };
  };
  $("#resultView").querySelectorAll("button[data-f]").forEach((b) => b.onclick = () => {
    const f = files();
    saveFiles(b.dataset.f === "all" ? Object.values(f) : [f[b.dataset.f]]);
  });
  $("#cbApply").onclick = async () => {
    const a = Number($("#cbA").value), bb = Number($("#cbB").value), leg = Number($("#cbLeg").value);
    const changedRange = !cb || Math.abs(a - cb.start_seconds) > 1e-3 || Math.abs(bb - cb.end_seconds) > 1e-3;
    if (changedRange) {
      if (!(bb > a) || a < 0) { toast("区間の開始と終了を確認してください"); return; }
      r.params.calibManual = { a: Math.round(a * r.params.fps), b: Math.round(bb * r.params.fps) };
    }
    r.params.legCm = leg > 0 ? leg : null;
    if (r.params.subject && leg > 0) await saveSubject(r.params.subject, leg);
    await saveRecomputed(r);
  };
  if ($("#cbAuto")) $("#cbAuto").onclick = async () => { r.params.calibManual = null; await saveRecomputed(r); };
  $("#resultView").scrollIntoView({ behavior: "smooth" });
}
async function saveRecomputed(r) {
  const c = calc(r);
  r.nSteps = c.steps.length; r.warnFlag = c.warnings.length > 0;
  await dbPut("results", r);
  await openResult(r.id); renderResults();
  toast("再計算しました");
}

// ---------- 起動 ----------
function updBadge() { $("#netBadge").textContent = !modelBytes ? "モデル未設定" : navigator.onLine ? "オフライン対応" : "オフラインで動作中"; }
(async () => {
  if ("serviceWorker" in navigator) { try { await navigator.serviceWorker.register("sw.js"); } catch {} }
  try { await navigator.storage?.persist?.(); } catch {}
  const m = await getModel();
  window.addEventListener("online", updBadge); window.addEventListener("offline", updBadge); updBadge();
  if (!m) toast("最初に「設定」タブで姿勢推定モデルを取り込んでください", 5000);
})();
