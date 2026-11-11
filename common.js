// 텔레파시 게임 공용 모듈: Firebase 연결, 점수 계산, 진행 액션
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, onValue, set, update, remove, get, onDisconnect, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

export const configured = !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("여기");
export const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = configured ? getAuth(app) : null;
export const db = configured ? getDatabase(app) : null;
export { ref, onValue, set, update, remove, get, onDisconnect, serverTimestamp, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut };

let offset = 0;
if (db) onValue(ref(db, ".info/serverTimeOffset"), s => { offset = s.val() || 0; });
export const serverNow = () => Date.now() + offset;

export const LEVELS = { easy: "쉬움", normal: "보통", hard: "어려움" };
export const LETTERS = ["A", "B", "C"];
export const LEAD_MS = 3000; // 문제를 먼저 보여 주고 선택지가 열리기까지

export const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const uid8 = p => p + Math.random().toString(36).slice(2, 10);

// 기본 설정: 13개 팀, 예시 문제
export function defaultConfig() {
  const teams = {};
  for (let i = 1; i <= 13; i++) teams["t" + String(i).padStart(2, "0")] = { name: i + "조", order: i };
  const qs = [
    ["탕수육은?", ["부먹", "찍먹"], "easy"],
    ["민트초코", ["좋다", "싫다"], "easy"],
    ["여행 갈 때 나는", ["계획형", "즉흥형"], "normal"],
    ["올영세일 때 나는", ["장바구니 미리 담기", "매장 가서 즉흥 쇼핑"], "normal"],
    ["출근길 커피", ["아이스", "따뜻한 거"], "easy"],
    ["메신저 답장은", ["바로 한다", "몰아서 한다"], "normal"],
    ["오늘 점심 메뉴", ["한식", "중식", "일식"], "hard"],
    ["매장에 가면 제일 먼저 가는 곳", ["스킨케어", "메이크업", "헬스푸드"], "hard"],
    ["입사 후 더 힘들었던 건", ["업무 적응", "사람 적응"], "normal"],
    ["멘토링에서 제일 좋았던 건", ["같이 먹은 밥", "고민 상담", "회사 꿀팁"], "hard"],
    ["1년 뒤 나에게 필요한 건", ["긴 휴가", "두둑한 보너스"], "normal"]
  ];
  const questions = {};
  qs.forEach(([text, options, level], i) => { questions["q" + String(i + 1).padStart(2, "0")] = { text, options, level, time: 10, order: i + 1 }; });
  return {
    title: "텔레파시 게임",
    settings: { mode: "count", threshold: 4, ratio: 60, points: { easy: 100, normal: 200, hard: 300 }, bonus: 0 },
    teams, questions
  };
}

export const listOf = obj => Object.entries(obj || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
export const teamsOf = cfg => listOf(cfg?.teams);
export const questionsOf = cfg => listOf(cfg?.questions).map(q => ({ ...q, options: Array.isArray(q.options) ? q.options : Object.values(q.options || {}) }));
export const pointsFor = (cfg, q) => Number(cfg?.settings?.points?.[q?.level] ?? 0);

export function requiredFor(cfg, members) {
  const s = cfg.settings || {};
  if (s.mode === "ratio") return Math.max(1, Math.ceil(members * Number(s.ratio || 60) / 100));
  return Math.max(1, Number(s.threshold || 4));
}

// 성공 기준을 사람이 읽는 문장으로
export function ruleText(cfg) {
  const s = cfg.settings || {};
  const base = s.mode === "ratio" ? `팀 접속 인원의 ${s.ratio}% 이상` : `${s.threshold}명 이상`;
  return `같은 답을 고른 사람이 ${base}이면 성공` + (Number(s.bonus) > 0 ? `, 전원 일치면 보너스 ${s.bonus}점` : "");
}

// 한 문제의 팀별 결과 계산 (순수 함수)
export function computeResult(cfg, q, votes, players, presence) {
  const n = q.options.length;
  const teams = {};
  for (const t of teamsOf(cfg)) {
    const counts = new Array(n).fill(0);
    const voters = new Set();
    for (const [uid, v] of Object.entries(votes || {})) {
      if (v && v.t === t.id && v.o >= 0 && v.o < n) { counts[v.o]++; voters.add(uid); }
    }
    const online = new Set(Object.keys(presence || {}).filter(uid => players?.[uid]?.team === t.id));
    const members = new Set([...online, ...voters]).size;
    const voted = voters.size;
    const top = Math.max(0, ...counts);
    const required = requiredFor(cfg, members);
    const success = voted > 0 && top >= required;
    const all = success && members > 1 && top === members;
    const points = success ? pointsFor(cfg, q) + (all ? Number(cfg.settings.bonus || 0) : 0) : 0;
    teams[t.id] = { counts, members, voted, required, top, success, all, points, pick: success ? counts.indexOf(top) : -1 };
  }
  return { qid: q.id, text: q.text, options: q.options, level: q.level, teams, at: serverNow() };
}

// 누적 점수와 순위. exceptQid를 주면 그 문제를 뺀 점수(prev)도 함께 계산
export function boardOf(cfg, results, exceptQid) {
  const rows = teamsOf(cfg).map(t => ({ id: t.id, name: t.name, score: 0, prev: 0 }));
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  for (const [qid, r] of Object.entries(results || {})) {
    for (const [tid, tr] of Object.entries(r.teams || {})) {
      if (!byId[tid]) continue;
      byId[tid].score += Number(tr.points || 0);
      if (qid !== exceptQid) byId[tid].prev += Number(tr.points || 0);
    }
  }
  const ranked = [...rows].sort((a, b) => b.score - a.score);
  let rank = 0, last = null;
  ranked.forEach((r, i) => { if (r.score !== last) { rank = i + 1; last = r.score; } r.rank = rank; });
  return ranked;
}

export const PHASE_NAME = { lobby: "입장 대기", question: "투표 중", closed: "투표 마감", reveal: "결과 공개", leaderboard: "순위 발표", final: "최종 결과" };

// 진행 액션 (관리자 전용, 보안 규칙이 막아 줘요)
export function makeActions(getCtx) {
  const g = () => getCtx().game || { phase: "lobby", qi: -1 };
  const qs = () => questionsOf(getCtx().cfg);
  async function start(qi) {
    const q = qs()[qi];
    if (!q) return;
    const t = serverNow();
    await remove(ref(db, "votes/" + q.id));
    await remove(ref(db, "results/" + q.id));
    await set(ref(db, "game"), { phase: "question", qi, qid: q.id, startAt: t + LEAD_MS, endsAt: t + LEAD_MS + Number(q.time || 10) * 1000, rev: (g().rev || 0) + 1 });
  }
  async function close() {
    const game = g();
    if (game.phase !== "question") return;
    await update(ref(db, "game"), { phase: "closed", endsAt: Math.min(game.endsAt || 0, serverNow()), rev: (game.rev || 0) + 1 });
  }
  async function reveal() {
    const game = g();
    if (!["question", "closed", "reveal"].includes(game.phase)) return;
    const q = qs()[game.qi];
    if (!q) return;
    const [v, p, pr] = await Promise.all([get(ref(db, "votes/" + q.id)), get(ref(db, "players")), get(ref(db, "presence"))]);
    const result = computeResult(getCtx().cfg, q, v.val(), p.val(), pr.val());
    await set(ref(db, "results/" + q.id), result);
    await update(ref(db, "game"), { phase: "reveal", rev: (game.rev || 0) + 1 });
  }
  const setPhase = phase => update(ref(db, "game"), { phase, rev: (g().rev || 0) + 1 });
  const A = {
    start,
    close,
    reveal,
    leaderboard: () => setPhase("leaderboard"),
    final: () => setPhase("final"),
    lobby: () => setPhase("lobby"),
    async next() {
      const qi = (g().qi ?? -1) + 1;
      if (qi < qs().length) await start(qi); else await setPhase("final");
    },
    async restart() { const qi = g().qi; if (qi >= 0) await start(qi); },
    async addTime() {
      const game = g();
      if (game.phase === "question") await update(ref(db, "game"), { endsAt: (game.endsAt || serverNow()) + 5000 });
    },
    async resetGame() {
      await remove(ref(db, "votes"));
      await remove(ref(db, "results"));
      await set(ref(db, "game"), { phase: "lobby", qi: -1, rev: (g().rev || 0) + 1 });
    },
    async clearPlayers() {
      await remove(ref(db, "votes"));
      await remove(ref(db, "players"));
      await remove(ref(db, "presence"));
    },
    async kick(uid) {
      await remove(ref(db, "players/" + uid));
      await remove(ref(db, "presence/" + uid));
    },
    // 단계별 다음 동작 (스페이스바, 큰 버튼)
    primaryLabel() {
      const game = g(), last = (game.qi ?? -1) + 1 >= qs().length;
      return ({ lobby: (game.qi ?? -1) >= 0 ? "이어서 다음 문제" : "첫 문제 시작", question: "지금 마감", closed: "결과 공개", reveal: "순위 보기", leaderboard: last ? "최종 결과" : "다음 문제", final: "대기 화면으로" })[game.phase] || "첫 문제 시작";
    },
    async primary() {
      const game = g();
      switch (game.phase) {
        case "question": return close();
        case "closed": return reveal();
        case "reveal": return A.leaderboard();
        case "leaderboard": return A.next();
        case "final": return A.lobby();
        default: return (game.qi ?? -1) >= 0 ? A.next() : start(0);
      }
    }
  };
  return A;
}

// 시간이 지나면 자동 마감 (관리자 화면이 열려 있을 때)
export function autoClose(getCtx, actions) {
  setInterval(() => {
    const game = getCtx().game;
    if (game && game.phase === "question" && serverNow() > game.endsAt + 300) actions.close().catch(() => {});
  }, 300);
}

// 관리자 로그인 확인: admins/{uid} 가 true 인지
export async function isAdmin(user) {
  if (!user || user.isAnonymous) return false;
  try { return (await get(ref(db, "admins/" + user.uid))).val() === true; } catch (e) { return false; }
}

export function notConfiguredHTML() {
  return `<div class="notice"><h1>Firebase 연결이 필요해요</h1><p>firebase-config.js 파일에 Firebase 프로젝트 값을 넣어 주세요. 자세한 순서는 README.md에 있어요.</p></div>`;
}

// 관리자 로그인 화면 (진행 화면, 관리자 페이지 공용)
export function mountLogin(el, onDone) {
  el.innerHTML = `<form class="login" id="loginForm">
    <h1>관리자 로그인</h1>
    <p>Firebase에 만든 관리자 계정으로 로그인해요.</p>
    <label for="lgEmail">이메일</label><input id="lgEmail" type="email" autocomplete="username" required>
    <label for="lgPw">비밀번호</label><input id="lgPw" type="password" autocomplete="current-password" required>
    <p class="err" id="lgErr" role="alert"></p>
    <button class="btn primary" type="submit">로그인</button>
  </form>`;
  const st = document.createElement("style");
  st.textContent = `.login{max-width:380px;margin:12vh auto;padding:0 20px;display:flex;flex-direction:column;gap:8px}
  .login h1{margin:0 0 4px;font-size:26px}.login p{margin:0 0 12px;color:var(--sub);line-height:1.6}
  .login label{font-size:14px;font-weight:700;margin-top:6px}.login input{padding:12px;border:1px solid var(--line);border-radius:10px}
  .login .err{color:var(--fail);min-height:1.2em;margin:6px 0}`;
  el.appendChild(st);
  el.querySelector("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = el.querySelector("#lgErr");
    err.textContent = "";
    try {
      const cred = await signInWithEmailAndPassword(auth, el.querySelector("#lgEmail").value.trim(), el.querySelector("#lgPw").value);
      if (!(await isAdmin(cred.user))) {
        err.textContent = "로그인은 됐지만 관리자로 등록되지 않았어요. UID: " + cred.user.uid;
        return;
      }
      onDone(cred.user);
    } catch (x) {
      err.textContent = "이메일이나 비밀번호를 다시 확인해 주세요.";
    }
  });
}
