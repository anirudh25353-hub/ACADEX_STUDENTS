let students = [];
const $ = s => document.querySelector(s);
const today = () => new Date().toISOString().slice(0, 10);
const colorFor = p => p >= 75 ? "var(--green)" : p >= 50 ? "var(--amber)" : "var(--red)";
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(url, method = "GET", body) {
  const res = await fetch(url, {method, headers: {"Content-Type": "application/json"}, body: body ? JSON.stringify(body) : undefined});
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/api/login") showAuth(false);
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

/* ---------- auth ---------- */
let setupMode = false;
function showAuth(setup) {
  setupMode = setup;
  $("#app").hidden = true; $("#cover").hidden = true; $("#profile").hidden = true; $("#auth").hidden = false;
  $("#authTitle").textContent = setup ? "Create teacher account" : "Teacher login";
  $("#authHint").textContent = setup ? "First time here. Choose a username and a password (6+ characters)." : "";
  $("#authBtn").textContent = setup ? "Create account" : "Log in";
  $("#setupFields").hidden = !setup;
  ["name", "subject_code", "subject_name"].forEach(n => $("#authForm").elements[n].required = setup);
}
$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const user = await api(setupMode ? "/api/setup" : "/api/login", "POST", Object.fromEntries(new FormData(e.target)));
    e.target.reset(); $("#authErr").textContent = ""; start(user.user, true);
  } catch (err) { $("#authErr").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => { await api("/api/logout", "POST"); showCover(); });

async function init() {
  const me = await api("/api/me");
  needsSetup = me.setup_needed;
  me.user ? start(me.user, false) : showCover();
}
function start(user, withProfile) {
  needsSetup = false; $("#cover").hidden = true; $("#auth").hidden = true;
  $("#who").textContent = user; $("#attDate").value ||= today(); loadTT(); loadTeachers(); loadActs();
  load(); loadAtt();
  if (withProfile) showProfile();
  else { showApp(); api("/api/profile").then(p => { if (p.teacher) setWho(p.teacher); }).catch(() => {}); }
}

/* ---------- cover page ---------- */
let needsSetup = false;
function showCover() { $("#app").hidden = true; $("#auth").hidden = true; $("#profile").hidden = true; $("#cover").hidden = false; window.scrollTo(0, 0); }
document.querySelectorAll(".loginBtn").forEach(b => b.addEventListener("click", () => showAuth(needsSetup)));
$("#backHome").addEventListener("click", showCover);
$("#contactForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("/api/contact", "POST", Object.fromEntries(new FormData(e.target)));
    e.target.reset(); $("#contactMsg").style.color = "var(--green)"; $("#contactMsg").textContent = "Thanks! Your message was sent.";
  } catch (err) { $("#contactMsg").style.color = "var(--red)"; $("#contactMsg").textContent = err.message; }
});

/* ---------- tabs ---------- */
document.querySelectorAll(".tabs [data-tab]").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs [data-tab]").forEach(x => x.classList.toggle("on", x === b));
  ["students", "attendance", "timetable", "teachers", "activities"].forEach(t => $("#tab-" + t).hidden = b.dataset.tab !== t);
  if (b.dataset.tab === "attendance") loadAtt();
  if (b.dataset.tab === "timetable") loadTT();
  if (b.dataset.tab === "activities") loadActs();
}));

/* ---------- students ---------- */
async function load() { students = await api("/api/students"); render(); renderTT(); renderActs(); }

function render() {
  const q = $("#search").value.toLowerCase(), sort = $("#sort").value;
  let list = students.filter(s => [s.name, s.roll, s.class].some(v => v.toLowerCase().includes(q)));
  if (sort === "top") list.sort((a, b) => b.percentage - a.percentage);
  if (sort === "low") list.sort((a, b) => a.percentage - b.percentage);
  if (sort === "att") list.sort((a, b) => (a.attendance.pct ?? 101) - (b.attendance.pct ?? 101));

  const graded = students.filter(s => s.marks.length), tracked = students.filter(s => s.attendance.days);
  const avg = graded.length ? (graded.reduce((t, s) => t + s.percentage, 0) / graded.length).toFixed(1) + "%" : "–";
  const att = tracked.length ? (tracked.reduce((t, s) => t + s.attendance.pct, 0) / tracked.length).toFixed(1) + "%" : "–";
  const top = graded.length ? graded.reduce((a, b) => a.percentage >= b.percentage ? a : b).name : "–";
  $("#stats").innerHTML = `
    <div class="stat"><b>${students.length}</b><span>students</span></div>
    <div class="stat"><b>${avg}</b><span>class average</span></div>
    <div class="stat"><b>${att}</b><span>attendance</span></div>
    <div class="stat"><b>${esc(top)}</b><span>top performer</span></div>`;
  $("#students").innerHTML = list.length ? list.map(card).join("") :
    `<p class="empty">${students.length ? "No students match your search." : "No students yet. Add one to get started."}</p>`;
}

function trend(marks) {
  const by = {};
  marks.forEach(m => { const d = m.date || "?"; (by[d] ??= [0, 0]); by[d][0] += m.score; by[d][1] += m.max_score; });
  const pts = Object.entries(by).sort().map(([d, [s, m]]) => ({d, p: s / m * 100}));
  if (pts.length < 2) return `<p class="meta">Add marks on two or more dates to see a progress chart.</p>`;
  const W = 400, H = 110, px = 28, py = 14;
  const x = i => px + i * (W - 2 * px) / (pts.length - 1), y = p => H - py - p / 100 * (H - 2 * py);
  const line = pts.map((t, i) => `${x(i)},${y(t.p)}`).join(" ");
  const dots = pts.map((t, i) => `<circle cx="${x(i)}" cy="${y(t.p)}" r="4" fill="${colorFor(t.p)}"><title>${t.d}: ${t.p.toFixed(1)}%</title></circle>`).join("");
  return `<div class="trend"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Percentage over time">
    <line x1="${px}" x2="${W-px}" y1="${y(50)}" y2="${y(50)}" stroke="var(--line)" stroke-dasharray="3"/>
    <text x="2" y="${y(100)+4}" font-size="10" fill="var(--muted)">100</text>
    <text x="6" y="${y(50)+4}" font-size="10" fill="var(--muted)">50</text>
    <polyline points="${line}" fill="none" stroke="var(--violet)" stroke-width="2"/>${dots}
    <text x="${px}" y="${H-1}" font-size="10" fill="var(--muted)">${pts[0].d}</text>
    <text x="${W-px}" y="${H-1}" font-size="10" fill="var(--muted)" text-anchor="end">${pts.at(-1).d}</text></svg></div>`;
}

const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const ini = n => n.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
function paint(el, t) {
  el.style.setProperty("--h", hue(t.name));
  el.style.backgroundImage = t.photo ? `url("${t.photo}")` : "";
  el.textContent = t.photo ? "" : ini(t.name);
}
function setWho(t) { $("#who").textContent = t.name; paint($("#whoAv"), t); }

function card(s) {
  const bars = s.marks.map(m => {
    const p = m.score / m.max_score * 100;
    return `<div class="bar"><span>${esc(m.subject)}</span>
      <div class="track"><div class="fill" style="width:${p}%;--c:${colorFor(p)}"></div></div>
      <span>${m.score}/${m.max_score}</span>
      <button class="x" title="Remove mark (${esc(m.date||"")})" onclick="delMark(${m.id})">✕</button></div>`;
  }).join("");
  const a = s.attendance;
  const attTxt = a.days ? `Attendance ${a.pct}% (${a.attended} of ${a.days} days${a.late ? `, ${a.late} late` : ""})` : "No attendance recorded yet.";
  return `<article class="card" style="--c:${colorFor(s.percentage)}">
    <div class="card-head">
      <div class="id"><div class="av" style="--h:${hue(s.name)}">${esc(ini(s.name))}</div>
        <div><h3>${esc(s.name)}</h3><div class="meta">Roll ${esc(s.roll)}, class ${esc(s.class)}</div>
          <div class="attline" style="${a.days && a.pct < 75 ? "color:var(--red);font-weight:600" : ""}">${attTxt}</div></div></div>
      <div class="score"><div class="ring" style="--p:${s.percentage}"><b>${s.percentage}%</b></div>
        <span class="badge">Grade ${s.grade}</span>
        <div><button class="ghost" onclick="delStudent(${s.id}, '${esc(s.name).replace(/'/g, "")}')">Delete</button></div></div>
    </div>
    ${stuChips(s)}<div class="bars">${bars || '<span class="meta">No marks recorded yet.</span>'}</div>
    ${trend(s.marks)}
    <form class="markform" onsubmit="addMark(event, ${s.id})">
      <input name="subject" placeholder="Subject" required>
      <input name="score" type="number" step="any" min="0" placeholder="Score" required>
      <input name="max_score" type="number" step="any" min="1" placeholder="Out of (100)">
      <input name="date" type="date" value="${today()}" aria-label="Date of test">
      <button>Add mark</button>
    </form></article>`;
}

$("#studentForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("/api/students", "POST", Object.fromEntries(new FormData(e.target)));
    e.target.reset(); $("#formErr").textContent = ""; load(); loadAtt();
  } catch (err) { $("#formErr").textContent = err.message; }
});
async function addMark(e, id) {
  e.preventDefault();
  try { await api(`/api/students/${id}/marks`, "POST", Object.fromEntries(new FormData(e.target))); load(); }
  catch (err) { alert(err.message); }
}
async function delMark(id) { await api(`/api/marks/${id}`, "DELETE"); load(); }
async function delStudent(id, name) {
  if (confirm(`Delete ${name} and all their marks and attendance?`)) { await api(`/api/students/${id}`, "DELETE"); load(); loadAtt(); }
}
$("#search").addEventListener("input", render);
$("#sort").addEventListener("change", render);

/* ---------- attendance ---------- */
async function loadAtt() {
  const rows = await api(`/api/attendance?date=${$("#attDate").value || today()}`);
  $("#attMsg").textContent = rows.length ? "" : "Add students first, then mark their attendance here.";
  $("#attList").innerHTML = rows.map(r => `<div class="att" data-id="${r.id}">
    <div><strong>${esc(r.name)}</strong> <span class="meta">Roll ${esc(r.roll)}, class ${esc(r.class)}</span></div>
    <div class="seg">${[["present","Present","p"],["late","Late","l"],["absent","Absent","a"]].map(([v, t, c]) =>
      `<label><input type="radio" name="st${r.id}" value="${v}" ${r.status === v ? "checked" : ""}><span class="${c}">${t}</span></label>`).join("")}
    </div></div>`).join("");
}
$("#attDate").addEventListener("change", loadAtt);
$("#allPresent").addEventListener("click", () =>
  document.querySelectorAll('#attList input[value="present"]').forEach(i => i.checked = true));
$("#saveAtt").addEventListener("click", async () => {
  const records = [...document.querySelectorAll("#attList .att")].map(el => {
    const c = el.querySelector("input:checked"); return c && {student_id: el.dataset.id, status: c.value};
  }).filter(Boolean);
  if (!records.length) { $("#attMsg").textContent = "Pick a status for at least one student."; return; }
  try {
    const r = await api("/api/attendance", "POST", {date: $("#attDate").value, records});
    $("#attMsg").textContent = `Saved attendance for ${r.saved} students.`; load();
  } catch (err) { $("#attMsg").textContent = err.message; }
});

$("#quickAdd").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, day = $("#attDate").value || today();
  try {
    const r = await api("/api/students", "POST", Object.fromEntries(new FormData(f)));
    if ($("#quickPresent").checked)
      await api("/api/attendance", "POST", {date: day, records: [{student_id: r.id, status: "present"}]});
    const name = f.name.value;
    f.reset(); $("#quickPresent").checked = true;
    $("#attMsg").textContent = `${name} was added${$("#quickPresent") && day ? " and marked present for " + day : ""}.`;
    load(); loadAtt();
  } catch (err) { $("#attMsg").textContent = err.message; }
});

/* ---------- timetable ---------- */
let slots = [];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
async function loadTT() { slots = await api("/api/timetable"); renderTT(); }
function renderTT() {
  const classes = [...new Set([...students.map(s => s.class), ...slots.map(s => s.class)])].sort();
  const teachers = [...new Set(slots.map(s => s.teacher))].sort();
  const cv = $("#ttClass").value, tv = $("#ttTeacher").value;
  const opts = (all, list, cur) => `<option value="">${all}</option>` +
    list.map(x => `<option value="${esc(x)}" ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
  $("#ttClass").innerHTML = opts("All classes", classes, cv);
  $("#ttTeacher").innerHTML = opts("All teachers", teachers, tv);
  const tnames = [...new Set([...teacherRows.map(t => t.name), ...slots.map(s => s.teacher)])].sort();
  $("#teacherList").innerHTML = tnames.map(n => `<option value="${esc(n)}">`).join("");
  $("#classList").innerHTML = classes.map(c => `<option value="${esc(c)}">`).join("");
  const shown = slots.filter(s => (!cv || s.class === cv) && (!tv || s.teacher === tv));
  const todayIdx = (new Date().getDay() + 6) % 7;
  $("#week").innerHTML = DAYS.map((d, i) => {
    const list = shown.filter(s => s.day === i).sort((a, b) => a.start < b.start ? -1 : 1);
    return `<div class="day ${i === todayIdx ? "today" : ""}"><h4>${d}</h4>` + (list.map(s =>
      `<div class="slot" style="--h:${hue(s.subject)}"><span class="t">${s.start} to ${s.end}</span><b>${esc(s.subject)}</b>
        <span>${esc(s.teacher)}${s.room ? ", room " + esc(s.room) : ""}</span>${cv ? "" : `<span class="meta">Class ${esc(s.class)}</span>`}
        <button class="x" title="Remove slot" onclick="delSlot(${s.id})">✕</button></div>`).join("") || '<p class="meta">No classes</p>') + "</div>";
  }).join("");
  renderTeachers();
}
$("#ttClass").addEventListener("change", renderTT);
$("#ttTeacher").addEventListener("change", renderTT);
$("#slotForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, keep = {cls: f.class.value, day: f.day.value};
  try {
    await api("/api/timetable", "POST", Object.fromEntries(new FormData(f)));
    f.reset(); f.class.value = keep.cls; f.day.value = keep.day; $("#slotErr").textContent = "";
    loadTT();
  } catch (err) { $("#slotErr").textContent = err.message; }
});
async function delSlot(id) { await api(`/api/timetable/${id}`, "DELETE"); loadTT(); }

/* ---------- teacher details ---------- */
let teacherRows = [];
async function loadTeachers() { teacherRows = await api("/api/teachers"); renderTT(); }
function renderTeachers() {
  const q = $("#tSearch").value.toLowerCase();
  const list = teacherRows.filter(t => [t.name, t.subject_code, t.subject_name, t.email].some(v => (v || "").toLowerCase().includes(q)));
  $("#teachBody").innerHTML = list.map(t => {
    const n = slots.filter(s => s.teacher.toLowerCase() === t.name.toLowerCase()).length;
    return `<tr><td><div class="id sm"><div class="av sm" style="--h:${hue(t.name)};${t.photo ? `background-image:url('${t.photo}')` : ""}">${t.photo ? "" : esc(ini(t.name))}</div><span class="nm">${esc(t.name)}</span></div></td>
      <td><span class="code">${esc(t.subject_code)}</span></td><td>${esc(t.subject_name)}</td><td>${t.designation || t.department ? `${esc(t.designation || "")}<div class="meta">${esc(t.department || "")}</div>` : "–"}</td>
      <td>${t.phone ? `<a href="tel:${esc(t.phone)}">${esc(t.phone)}</a>` : "–"}</td>
      <td>${t.email ? `<a href="mailto:${esc(t.email)}">${esc(t.email)}</a>` : "–"}</td>
      <td>${t.username ? `<span class="meta">${esc(t.username)}</span>` : "–"}</td><td>${n}</td><td><button class="ghost" onclick="delTeacher(${t.id}, '${esc(t.name).replace(/'/g, "")}')">Delete</button></td></tr>`;
  }).join("") || `<tr><td colspan="9" class="empty">${teacherRows.length ? "No teachers match your search." : "No teachers yet. Add one to get started."}</td></tr>`;
}
$("#tSearch").addEventListener("input", renderTeachers);
$("#teacherForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("/api/teachers", "POST", Object.fromEntries(new FormData(e.target)));
    e.target.reset(); $("#teacherErr").textContent = ""; loadTeachers();
  } catch (err) { $("#teacherErr").textContent = err.message; }
});
async function delTeacher(id, name) {
  if (confirm(`Remove ${name} from the teacher list? Their timetable slots stay.`)) { await api(`/api/teachers/${id}`, "DELETE"); loadTeachers(); }
}

/* ---------- teacher profile (first screen after login) ---------- */
let curProfile = null;
const PF = ["name", "subject_code", "subject_name", "phone", "email", "department", "designation"];
function showApp() { $("#profile").hidden = true; $("#app").hidden = false; window.scrollTo(0, 0); }
async function showProfile() {
  ["#cover", "#auth", "#app"].forEach(s => $(s).hidden = true);
  $("#profile").hidden = false; window.scrollTo(0, 0);
  curProfile = await api("/api/profile"); renderProfile();
}
function renderProfile() {
  const p = curProfile, t = p.teacher, f = $("#profileForm");
  $("#pView").hidden = !t; f.hidden = !!t; $("#pActions").hidden = !t; $("#pCancel").hidden = !t;
  $("#pFormTitle").textContent = "Complete your teacher profile";
  $("#pErr").textContent = "";
  if (!t) return;
  setWho(t); paint($("#pAv"), t);
  $("#pName").textContent = t.name; $("#pSubj").textContent = `${t.subject_name} (${t.subject_code})`;
  $("#pRole").textContent = [t.designation, t.department].filter(Boolean).join(", ");
  $("#pPhone").textContent = t.phone || "–"; $("#pEmail").textContent = t.email || "–"; $("#pUser").textContent = p.user;
  $("#pStats").innerHTML = [[p.stats.week, "classes a week"], [p.stats.classes.length, "classes taught"], [p.stats.students, "students"]]
    .map(([n, l]) => `<div class="pstat"><b>${n}</b><span>${l}</span></div>`).join("");
  $("#pToday").innerHTML = p.today.map(s => `<div class="slot" style="--h:${hue(s.subject)}"><span class="t">${s.start} to ${s.end}</span>
    <b>${esc(s.subject)}</b><span>Class ${esc(s.class)}${s.room ? ", room " + esc(s.room) : ""}</span></div>`).join("")
    || '<p class="meta">No classes scheduled today.</p>';
}
$("#pContinue").addEventListener("click", showApp);
$("#myProfile").addEventListener("click", showProfile);
$("#pLogout").addEventListener("click", async () => { await api("/api/logout", "POST"); showCover(); });
$("#pEdit").addEventListener("click", () => {
  const f = $("#profileForm"), t = curProfile.teacher;
  PF.forEach(k => f.elements[k].value = t[k] || ""); f.elements.photo.value = "";
  $("#pView").hidden = true; $("#pActions").hidden = true; f.hidden = false; $("#pFormTitle").textContent = "Edit your profile";
});
$("#pCancel").addEventListener("click", renderProfile);
$("#profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(e.target)), file = e.target.elements.photo.files[0];
    delete data.photo;
    await api("/api/profile", "POST", data);
    if (file) {
      const fd = new FormData(); fd.append("photo", file);
      const r = await fetch("/api/profile/photo", {method: "POST", body: fd});
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Photo upload failed.");
    }
    loadTeachers(); loadTT(); showProfile();
  } catch (err) { $("#pErr").textContent = err.message; }
});

/* ---------- extra-curricular activities ---------- */
const CATS = {"Music": ["🎵", 285], "Dance": ["💃", 330], "Arts": ["🎨", 20], "Sports": ["⚽", 145], "Clubs": ["🤝", 200],
  "Drama": ["🎭", 265], "Debate": ["🎤", 35], "Science & Tech": ["💻", 215], "Community service": ["🌱", 120], "Other": ["✨", 50]};
const LEVELS = ["School", "Inter-school", "District", "State", "National", "International", "Other"];
const ROLES = ["Member", "Captain", "Vice captain", "Lead", "Coordinator"];
const catIcon = c => (CATS[c] || CATS.Other)[0], catHue = c => (CATS[c] || CATS.Other)[1];
let acts = [], actFilter = "", openAct = null;
$("#actCat").innerHTML = Object.keys(CATS).map(c => `<option value="${c}">${CATS[c][0]} ${c}</option>`).join("");

function stuChips(s) {
  if (!s.activities || (!s.activities.length && !s.trophies)) return "";
  return `<div class="chips">` + s.activities.map(a => `<span class="chip" style="--h:${catHue(a.category)}">${catIcon(a.category)} ${esc(a.name)}${a.role !== "Member" ? " · " + esc(a.role) : ""}</span>`).join("") +
    (s.trophies ? `<span class="chip gold">🏆 ${s.trophies}</span>` : "") + `</div>`;
}
async function loadActs() { acts = await api("/api/activities"); renderActs(); }
function sched(a) {
  return [a.day !== null && a.day !== undefined ? DAYS[a.day] : "", a.start ? `${a.start} to ${a.end}` : "", a.venue].filter(Boolean).join(" · ") || "No fixed schedule";
}
function renderActs() {
  const people = new Set(acts.flatMap(a => a.members.map(m => m.student_id)));
  const wins = acts.reduce((n, a) => n + a.achievements.length, 0);
  $("#actStats").innerHTML = [[acts.length, "activities"], [`${people.size} of ${students.length}`, "students taking part"], [wins, "achievements"]]
    .map(([n, l]) => `<div class="pstat"><b>${n}</b><span>${l}</span></div>`).join("");
  const counts = {}; acts.forEach(a => counts[a.category] = (counts[a.category] || 0) + 1);
  $("#actChips").innerHTML = `<button class="cat ${actFilter ? "" : "on"}" data-c="">All (${acts.length})</button>` +
    Object.keys(CATS).map(c => `<button class="cat ${actFilter === c ? "on" : ""}" data-c="${c}">${CATS[c][0]} ${c} (${counts[c] || 0})</button>`).join("");
  const list = acts.filter(a => !actFilter || a.category === actFilter);
  $("#actList").innerHTML = list.map(actCard).join("") ||
    `<p class="empty">${acts.length ? "No activities in this category yet." : "No activities yet. Add one to get started."}</p>`;
}
function actCard(a) {
  const open = openAct === a.id, ids = new Set(a.members.map(m => m.student_id));
  const free = students.filter(s => !ids.has(s.id));
  const manage = !open ? "" : `<div class="manage">
    <form class="inl" onsubmit="enroll(event, ${a.id})">
      <select name="student_id" required>${free.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.class)})</option>`).join("") || '<option value="">Every student is enrolled</option>'}</select>
      <select name="role">${ROLES.map(r => `<option>${r}</option>`).join("")}</select><button>Enroll</button></form>
    <div>${a.members.map(m => `<div class="mrow"><div class="av sm" style="--h:${hue(m.name)}">${esc(ini(m.name))}</div>
      <span class="grow"><b>${esc(m.name)}</b> <span class="meta">class ${esc(m.class)}</span></span><span class="tag">${esc(m.role)}</span>
      <button class="x" title="Remove from activity" onclick="rmMember(${a.id}, ${m.student_id})">✕</button></div>`).join("") || '<p class="meta">No members yet.</p>'}</div>
    ${a.members.length ? `<form class="inl" onsubmit="addAch(event, ${a.id})">
      <select name="student_id">${a.members.map(m => `<option value="${m.student_id}">${esc(m.name)}</option>`).join("")}</select>
      <input name="title" placeholder="Achievement (e.g. First place, inter-school quiz)" required>
      <select name="level">${LEVELS.map(l => `<option>${l}</option>`).join("")}</select>
      <input type="date" name="date" value="${today()}" aria-label="Date"><button>Add achievement</button></form>` : ""}
    ${a.achievements.map(x => `<div class="mrow">🏆 <span class="grow"><b>${esc(x.title)}</b> <span class="meta">${esc(x.name)}, ${esc(x.level)}, ${esc(x.date || "")}</span></span>
      <button class="x" title="Remove achievement" onclick="delAch(${x.id})">✕</button></div>`).join("")}</div>`;
  const n = a.members.length, w = a.achievements.length;
  return `<article class="act" style="--h:${catHue(a.category)}">
    <div class="act-head"><div class="act-ic">${catIcon(a.category)}</div>
      <div class="grow"><h3>${esc(a.name)}</h3><span class="tag">${esc(a.category)}</span></div>
      <button class="ghost" onclick="delAct(${a.id}, '${esc(a.name).replace(/'/g, "")}')">Delete</button></div>
    <p class="meta actmeta">${a.coach ? "Coach: " + esc(a.coach) + " · " : ""}${esc(sched(a))}</p>
    <div class="actrow"><span>${n} member${n === 1 ? "" : "s"} · ${w} achievement${w === 1 ? "" : "s"}</span>
      <button class="alt sm" onclick="toggleAct(${a.id})">${open ? "Close" : "Manage"}</button></div>${manage}</article>`;
}
$("#actChips").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { actFilter = b.dataset.c; renderActs(); } });
function toggleAct(id) { openAct = openAct === id ? null : id; renderActs(); }
async function refreshActs() { await loadActs(); load(); }
async function enroll(e, id) {
  e.preventDefault();
  try { await api(`/api/activities/${id}/members`, "POST", Object.fromEntries(new FormData(e.target))); refreshActs(); }
  catch (err) { alert(err.message); }
}
async function rmMember(id, sid) { await api(`/api/activities/${id}/members/${sid}`, "DELETE"); refreshActs(); }
async function addAch(e, id) {
  e.preventDefault();
  try { await api(`/api/activities/${id}/achievements`, "POST", Object.fromEntries(new FormData(e.target))); refreshActs(); }
  catch (err) { alert(err.message); }
}
async function delAch(id) { await api(`/api/achievements/${id}`, "DELETE"); refreshActs(); }
async function delAct(id, name) {
  if (confirm(`Delete ${name} and its member list?`)) { await api(`/api/activities/${id}`, "DELETE"); if (openAct === id) openAct = null; refreshActs(); }
}
$("#actForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const r = await api("/api/activities", "POST", Object.fromEntries(new FormData(e.target)));
    e.target.reset(); $("#actErr").textContent = ""; openAct = r.id; loadActs();
  } catch (err) { $("#actErr").textContent = err.message; }
});

init();
