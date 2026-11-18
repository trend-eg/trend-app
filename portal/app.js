/* بوابة مراجعة التصميمات · ترند
 * الملف ده فيه كل منطق الموقع: الدخول، صفحات العميل، لوحة الأدمن، والتعليقات على التصميم.
 * فيه طبقتين للبيانات بنفس الشكل: Supabase (الشغل الحقيقي) و Demo (تجربة على الجهاز).
 */
(() => {
"use strict";

const CFG = window.PORTAL_CONFIG || {};
const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const AR_MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
const monthLabel = (iso) => { const [y, m] = iso.split("-").map(Number); return `${AR_MONTHS[m - 1]} ${y}`; };
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("ar-EG", { day: "numeric", month: "long" }) : "";
const fmtDateTime = (d) => d ? new Date(d).toLocaleString("ar-EG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function normalizePhone(p) {
  let d = String(p || "").replace(/[٠-٩]/g, (c) => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D/g, "");
  if (d.startsWith("0020")) d = d.slice(2);
  if (/^01[0125]\d{8}$/.test(d)) d = "2" + d;
  return /^201[0125]\d{8}$/.test(d) ? d : null;
}
const phoneToEmail = (p) => { const n = normalizePhone(p); return n ? `${n}@clients.trend-eg.com` : null; };
const prettyPhone = (n) => n && n.startsWith("20") ? "0" + n.slice(2) : n;

const STATUS = {
  pending:  { cls: "b-pending",  client: "مستني مراجعتك", admin: "مستني العميل" },
  changes:  { cls: "b-changes",  client: "طلبت تعديل",    admin: "مطلوب تعديل" },
  approved: { cls: "b-approved", client: "اتوافق عليه",    admin: "اتوافق عليه" },
};
const CATS = { text: "نص", colors: "ألوان", image: "صورة", logo: "لوجو", caption: "كابشن", other: "حاجة تانية" };
const badge = (s) => `<span class="badge ${STATUS[s].cls}">${STATUS[s][isAdmin() ? "admin" : "client"]}</span>`;

function toast(msg, opts = {}) {
  const t = document.createElement("div");
  t.className = "toast" + (opts.bad ? " bad" : "");
  t.innerHTML = `<span style="flex:1">${msg}</span>`;
  $("#toast").append(t);
  setTimeout(() => t.remove(), opts.ms || 3800);
}
const fail = (e) => { console.error(e); toast(esc(friendlyError(e)), { bad: true, ms: 6000 }); };
function friendlyError(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  if (/Invalid login credentials/i.test(m)) return "رقم الموبايل أو الباسورد غلط";
  if (/Failed to fetch|NetworkError/i.test(m)) return "مفيش اتصال بالإنترنت أو السيرفر مش بيرد";
  if (/JWT|session/i.test(m)) return "انتهت الجلسة، ادخل تاني";
  return m;
}

const loadingHTML = `<div class="loading"><div class="spin"></div></div>`;

// confirm/prompt dialogs
const dlg = $("#dlg");
function openDialog(title, bodyHTML, { okText = "حفظ", okClass = "primary", onOk, wide } = {}) {
  dlg.style.width = wide ? "min(680px,calc(100vw - 32px))" : "";
  dlg.innerHTML = `<form method="dialog" class="form" novalidate>
    <div class="dh"><h2>${title}</h2><div class="spacer"></div><button type="button" class="btn ghost iconbtn" data-x aria-label="إغلاق">✕</button></div>
    <div class="db form">${bodyHTML}<div class="err" data-err></div></div>
    <div class="df"><button class="btn ${okClass}" data-ok>${okText}</button><button type="button" class="btn ghost" data-x>إلغاء</button></div>
  </form>`;
  const form = $("form", dlg);
  $$("[data-x]", dlg).forEach((b) => b.onclick = () => dlg.close());
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $("[data-ok]", dlg); const err = $("[data-err]", dlg);
    err.textContent = ""; btn.disabled = true;
    try { const r = await onOk?.(form); if (r !== false) dlg.close(); }
    catch (e) { console.error(e); err.textContent = friendlyError(e); }
    finally { btn.disabled = false; }
  };
  dlg.showModal();
  setTimeout(() => $("input,textarea,select", dlg)?.focus(), 30);
  return form;
}
const confirmBox = (title, text, okText = "تأكيد", okClass = "primary") =>
  new Promise((res) => {
    let ok = false;
    openDialog(title, `<p style="margin:0">${text}</p>`, { okText, okClass, onOk: () => { ok = true; } });
    dlg.addEventListener("close", () => res(ok), { once: true });
  });

// ------------------------------------------------------------------ Supabase backend
function supabaseApi() {
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const B = "designs";
  const ok = ({ data, error }) => { if (error) throw error; return data; };
  const sign = async (paths) => {
    const uniq = [...new Set(paths.filter(Boolean))];
    if (!uniq.length) return {};
    const data = ok(await sb.storage.from(B).createSignedUrls(uniq, 3600));
    return Object.fromEntries(data.filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  };
  const ext = (f) => (f.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  async function uploadImages(design, version, files) {
    const rows = [];
    for (let i = 0; i < files.length; i++) {
      const path = `${design.client_id}/${design.id}/v${version}-${i}-${Math.random().toString(36).slice(2, 8)}.${ext(files[i])}`;
      ok(await sb.storage.from(B).upload(path, files[i], { contentType: files[i].type, upsert: false }));
      rows.push({ design_id: design.id, client_id: design.client_id, version, path, sort: i });
    }
    ok(await sb.from("design_images").insert(rows));
  }
  async function removeFilesWhere(col, val) {
    const imgs = ok(await sb.from("design_images").select("path").eq(col, val));
    if (imgs.length) await sb.storage.from(B).remove(imgs.map((i) => i.path));
  }
  return {
    async signIn(phone, password) {
      const email = phoneToEmail(phone);
      if (!email) throw new Error("اكتب رقم موبايل مصري صحيح، زي 01012345678");
      ok(await sb.auth.signInWithPassword({ email, password }));
      return this.me();
    },
    async signOut() { await sb.auth.signOut(); },
    async me() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;
      const p = ok(await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle());
      if (!p) { await sb.auth.signOut(); throw new Error("الحساب ده مش متسجل في البوابة"); }
      return p;
    },
    async overview() {
      const clients = ok(await sb.from("clients").select("id,name,created_at,designs(status),comments(resolved)").order("name"));
      return clients.map((c) => ({ ...c, designs: c.designs || [], open: (c.comments || []).filter((x) => !x.resolved).length }));
    },
    async client(id) { return ok(await sb.from("clients").select("*").eq("id", id).single()); },
    async contacts(clientId) { return ok(await sb.from("profiles").select("*").eq("client_id", clientId).order("created_at")); },
    async createClient(name, contact, phone, pw) { return ok(await sb.rpc("admin_create_client", { p_client_name: name, p_contact_name: contact, p_phone: phone, p_password: pw })); },
    async renameClient(id, name) { ok(await sb.from("clients").update({ name }).eq("id", id)); },
    async deleteClient(id) {
      await removeFilesWhere("client_id", id);
      const users = ok(await sb.from("profiles").select("id").eq("client_id", id));
      for (const u of users) ok(await sb.rpc("admin_delete_user", { p_user: u.id }));
      ok(await sb.from("clients").delete().eq("id", id));
    },
    async addContact(clientId, name, phone, pw, canApprove) { return ok(await sb.rpc("admin_add_contact", { p_client: clientId, p_name: name, p_phone: phone, p_password: pw, p_can_approve: canApprove })); },
    async setCanApprove(userId, v) { ok(await sb.from("profiles").update({ can_approve: v }).eq("id", userId)); },
    async setPassword(userId, pw) { ok(await sb.rpc("admin_set_password", { p_user: userId, p_password: pw })); },
    async deleteUser(userId) { ok(await sb.rpc("admin_delete_user", { p_user: userId })); },
    async months(clientId) {
      return ok(await sb.from("months").select("id,label,period,client_id,designs(status)").eq("client_id", clientId).order("period", { ascending: false }));
    },
    async month(id) { return ok(await sb.from("months").select("*, clients(name)").eq("id", id).single()); },
    async createMonth(clientId, period) {
      return ok(await sb.from("months").insert({ client_id: clientId, period, label: monthLabel(period) }).select().single());
    },
    async deleteMonth(id) {
      const ds = ok(await sb.from("designs").select("id").eq("month_id", id));
      for (const d of ds) await removeFilesWhere("design_id", d.id);
      ok(await sb.from("months").delete().eq("id", id));
    },
    async designs(monthId) {
      const ds = ok(await sb.from("designs").select("*, comments(id,resolved,version)").eq("month_id", monthId).order("sort").order("created_at"));
      if (!ds.length) return [];
      const imgs = ok(await sb.from("design_images").select("design_id,version,path,sort").in("design_id", ds.map((d) => d.id)).order("sort"));
      const cover = {}; const count = {};
      for (const d of ds) {
        const mine = imgs.filter((i) => i.design_id === d.id && i.version === d.version);
        cover[d.id] = mine[0]?.path; count[d.id] = mine.length;
      }
      const urls = await sign(Object.values(cover));
      return ds.map((d) => ({ ...d, cover: urls[cover[d.id]], imageCount: count[d.id],
        openComments: (d.comments || []).filter((c) => !c.resolved && c.version === d.version).length }));
    },
    async design(id) {
      const d = ok(await sb.from("designs").select("*, months(id,label,client_id), clients(name)").eq("id", id).single());
      const [imgs, comments, events] = await Promise.all([
        sb.from("design_images").select("*").eq("design_id", id).order("version").order("sort").then(ok),
        sb.from("comments").select("*").eq("design_id", id).order("created_at").then(ok),
        sb.from("design_events").select("*").eq("design_id", id).order("at", { ascending: false }).then(ok),
      ]);
      const urls = await sign(imgs.map((i) => i.path));
      return { ...d, images: imgs.map((i) => ({ ...i, url: urls[i.path] })), comments, events };
    },
    async createDesign(month, fields, files) {
      const d = ok(await sb.from("designs").insert({ month_id: month.id, client_id: month.client_id, ...fields }).select().single());
      try { await uploadImages(d, 1, files); }
      catch (e) { await removeFilesWhere("design_id", d.id).catch(() => {}); await sb.from("designs").delete().eq("id", d.id); throw e; }
      return d;
    },
    async updateDesign(id, fields) { ok(await sb.from("designs").update(fields).eq("id", id)); },
    async deleteDesign(id) { await removeFilesWhere("design_id", id); ok(await sb.from("designs").delete().eq("id", id)); },
    async newVersion(design, files) {
      const v = ok(await sb.rpc("admin_bump_version", { p_design: design.id }));
      await uploadImages(design, v, files);
      return v;
    },
    async review(designId, status) { ok(await sb.rpc("client_review", { p_design: designId, p_status: status })); },
    async addComment(c) { return ok(await sb.from("comments").insert(c).select().single()); },
    async deleteComment(id) { ok(await sb.from("comments").delete().eq("id", id)); },
    async resolveComment(id, v) { ok(await sb.from("comments").update({ resolved: v, resolved_at: v ? new Date().toISOString() : null }).eq("id", id)); },
    async openComments() {
      return ok(await sb.from("comments").select("*, designs(id,title,status,version,month_id,months(label)), clients(id,name)").eq("resolved", false).order("created_at"));
    },
  };
}

// ------------------------------------------------------------------ Demo backend (localStorage)
function demoApi() {
  const KEY = "trend-portal-demo-v1";
  const poster = (bg, fg, title, sub, n) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
      <rect width="1080" height="1350" fill="${bg}"/>
      <circle cx="${820 - n * 40}" cy="${300 + n * 30}" r="260" fill="${fg}" opacity=".18"/>
      <rect x="90" y="880" width="420" height="16" rx="8" fill="${fg}" opacity=".6"/>
      <text x="990" y="640" fill="${fg}" font-family="Tahoma,sans-serif" font-size="88" font-weight="700" text-anchor="start" direction="rtl">${title}</text>
      <text x="990" y="760" fill="${fg}" font-family="Tahoma,sans-serif" font-size="46" text-anchor="start" direction="rtl" opacity=".85">${sub}</text>
      <rect x="90" y="1150" width="300" height="100" rx="50" fill="${fg}"/>
      <text x="240" y="1215" fill="${bg}" font-family="Tahoma,sans-serif" font-size="40" font-weight="700" text-anchor="middle">اطلب دلوقتي</text>
      <rect x="880" y="90" width="110" height="110" rx="24" fill="${fg}"/>
      <text x="935" y="165" fill="${bg}" font-family="Tahoma,sans-serif" font-size="44" font-weight="700" text-anchor="middle">LOGO</text>
    </svg>`);
  const seed = () => {
    const now = Date.now(); const ago = (h) => new Date(now - h * 3600e3).toISOString();
    const A = "admin-1", c1 = "client-1", c2 = "client-2", u1 = "user-1", u2 = "user-2", u3 = "user-3";
    const s = {
      users: [
        { id: A, role: "admin", client_id: null, name: "فريق ترند", phone: "201000000000", can_approve: true, pw: "123456", created_at: ago(900) },
        { id: u1, role: "client", client_id: c1, name: "أحمد (مطعم الشرقاوي)", phone: "201111111111", can_approve: true, pw: "123456", created_at: ago(800) },
        { id: u3, role: "client", client_id: c1, name: "منى – ماركتينج", phone: "201011111111", can_approve: false, pw: "123456", created_at: ago(700) },
        { id: u2, role: "client", client_id: c2, name: "د. سارة", phone: "201222222222", can_approve: true, pw: "123456", created_at: ago(600) },
      ],
      clients: [{ id: c1, name: "مطعم الشرقاوي", created_at: ago(800) }, { id: c2, name: "عيادة د. سارة للأسنان", created_at: ago(600) }],
      months: [
        { id: "m1", client_id: c1, period: "2026-11-01", label: "نوفمبر 2026", created_at: ago(100) },
        { id: "m0", client_id: c1, period: "2026-10-01", label: "أكتوبر 2026", created_at: ago(800) },
        { id: "m2", client_id: c2, period: "2026-11-01", label: "نوفمبر 2026", created_at: ago(90) },
      ],
      designs: [], images: [], comments: [], events: [],
    };
    const palette = [["#821a2f", "#ffffff"], ["#f4e9d8", "#5a1020"], ["#1f3b2d", "#f7e7c6"], ["#d97706", "#ffffff"], ["#23161a", "#f0a640"], ["#ffffff", "#821a2f"]];
    const mk = (id, month, client, title, sub, status, n, extra = {}) => {
      const [bg, fg] = palette[n % palette.length];
      s.designs.push({ id, month_id: month, client_id: client, title, caption: extra.caption || `${title} 🔥\nاطلب دلوقتي من خلال الرابط في البايو أو كلمنا واتساب.`, publish_on: extra.publish_on || null, sort: n, version: extra.version || 1, status, reviewed_at: status === "pending" ? null : ago(20), reviewed_by: status === "pending" ? null : u1, created_at: ago(100 - n) });
      const pages = extra.pages || 1;
      for (let v = 1; v <= (extra.version || 1); v++)
        for (let p = 0; p < pages; p++)
          s.images.push({ id: uid(), design_id: id, client_id: client, version: v, sort: p, path: `${id}-${v}-${p}`, url: poster(v === (extra.version || 1) ? bg : "#888", fg, title + (pages > 1 ? ` ${p + 1}/${pages}` : ""), sub + (v > 1 && v === extra.version ? " · نسخة " + v : ""), n + p) });
    };
    mk("d1", "m1", c1, "عرض الويك إند", "خصم 20% على كل الوجبات", "approved", 0, { publish_on: "2026-11-06" });
    mk("d2", "m1", c1, "منيو الفطار الجديد", "من 8 الصبح لـ 12 الضهر", "changes", 1, { publish_on: "2026-11-09", pages: 3 });
    mk("d3", "m1", c1, "وجبة العيلة", "تكفي 4 أفراد بـ 499 جنيه", "pending", 2, { publish_on: "2026-11-12", version: 2 });
    mk("d4", "m1", c1, "رأي عملائنا", "⭐⭐⭐⭐⭐", "pending", 3, { publish_on: "2026-11-15" });
    mk("d5", "m1", c1, "توصيل مجاني", "لأي طلب فوق 300 جنيه", "pending", 4, { publish_on: "2026-11-18" });
    mk("d0", "m0", c1, "افتتاح الفرع التاني", "في التجمع الخامس", "approved", 5);
    mk("d6", "m2", c2, "تبييض الأسنان", "جلسة واحدة ونتيجة فورية", "pending", 0);
    mk("d7", "m2", c2, "تقويم شفاف", "استشارة مجانية", "pending", 3);
    const cm = (design, version, x, y, img, cat, body, author, resolved, h) =>
      s.comments.push({ id: uid(), design_id: design, client_id: c1, version, x, y, img_index: img, category: cat, body, author_id: author, author_name: s.users.find((u) => u.id === author).name, resolved, resolved_at: resolved ? ago(h - 1) : null, created_at: ago(h) });
    cm("d2", 1, 78, 12, 0, "logo", "اللوجو صغير شوية، كبّره ووضّحه أكتر", u1, false, 18);
    cm("d2", 1, 50, 48, 0, "text", "اكتبوا \"فطار\" بدل \"بريكفاست\"", u3, false, 17);
    cm("d2", 1, 30, 70, 1, "colors", "اللون الأحمر غامق، عايزينه أفتح", u1, false, 16);
    cm("d2", 1, null, null, null, "caption", "زودوا رقم التليفون في الكابشن: 01000000000", u1, false, 15);
    cm("d3", 1, 40, 55, 0, "text", "السعر غلط، المفروض 499 مش 549", u1, true, 40);
    s.events.push({ id: 1, design_id: "d1", client_id: c1, version: 1, action: "approved", user_id: u1, user_name: "أحمد (مطعم الشرقاوي)", at: ago(20) });
    s.events.push({ id: 2, design_id: "d2", client_id: c1, version: 1, action: "changes", user_id: u1, user_name: "أحمد (مطعم الشرقاوي)", at: ago(15) });
    s.events.push({ id: 3, design_id: "d3", client_id: c1, version: 1, action: "changes", user_id: u1, user_name: "أحمد (مطعم الشرقاوي)", at: ago(39) });
    s.events.push({ id: 4, design_id: "d3", client_id: c1, version: 2, action: "new_version", user_id: A, user_name: "فريق ترند", at: ago(10) });
    s.designs.find((d) => d.id === "d3").status = "pending";
    return s;
  };
  let st;
  try { st = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!st || !st.users) st = seed();
  let meId = null;
  try { meId = localStorage.getItem(KEY + "-me"); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  const setMe = (id) => { meId = id; try { id ? localStorage.setItem(KEY + "-me", id) : localStorage.removeItem(KEY + "-me"); } catch {} };
  const wait = (v) => new Promise((r) => setTimeout(() => r(structuredClone(v)), 120));
  const me = () => st.users.find((u) => u.id === meId);
  const guard = (clientId) => { const m = me(); if (!m) throw new Error("انتهت الجلسة، ادخل تاني"); if (m.role !== "admin" && m.client_id !== clientId) throw new Error("غير مسموح"); };
  const admin = () => { if (me()?.role !== "admin") throw new Error("غير مسموح"); };
  const pub = (u) => { const { pw, ...r } = u; return r; };
  const readFiles = (files) => Promise.all([...files].map((f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); })));
  const addUser = (name, phone, pw, role, client, canApprove) => {
    const n = normalizePhone(phone);
    if (!n) throw new Error("رقم الموبايل غير صحيح");
    if ((pw || "").length < 6) throw new Error("الباسورد لازم يكون 6 حروف أو أرقام على الأقل");
    if (st.users.some((u) => u.phone === n)) throw new Error("الرقم ده مسجل قبل كده");
    const u = { id: uid(), role, client_id: client, name, phone: n, can_approve: canApprove !== false, pw, created_at: new Date().toISOString() };
    st.users.push(u); return u;
  };
  return {
    reset() { st = seed(); save(); },
    async signIn(phone, pw) {
      const n = normalizePhone(phone);
      if (!n) throw new Error("اكتب رقم موبايل مصري صحيح، زي 01012345678");
      const u = st.users.find((x) => x.phone === n && x.pw === pw);
      if (!u) throw new Error("Invalid login credentials");
      setMe(u.id); return wait(pub(u));
    },
    async signOut() { setMe(null); },
    async me() { const m = me(); return m ? wait(pub(m)) : null; },
    async overview() {
      admin();
      return wait(st.clients.map((c) => ({ ...c, designs: st.designs.filter((d) => d.client_id === c.id).map((d) => ({ status: d.status })), open: st.comments.filter((x) => x.client_id === c.id && !x.resolved).length })).sort((a, b) => a.name.localeCompare(b.name, "ar")));
    },
    async client(id) { guard(id); return wait(st.clients.find((c) => c.id === id)); },
    async contacts(id) { guard(id); return wait(st.users.filter((u) => u.client_id === id).map(pub)); },
    async createClient(name, contact, phone, pw) {
      admin(); const c = { id: uid(), name, created_at: new Date().toISOString() };
      addUser(contact, phone, pw, "client", c.id, true); st.clients.push(c); save(); return c.id;
    },
    async renameClient(id, name) { admin(); st.clients.find((c) => c.id === id).name = name; save(); },
    async deleteClient(id) {
      admin();
      const ds = st.designs.filter((d) => d.client_id === id).map((d) => d.id);
      st.users = st.users.filter((u) => u.client_id !== id); st.clients = st.clients.filter((c) => c.id !== id);
      st.months = st.months.filter((m) => m.client_id !== id); st.designs = st.designs.filter((d) => d.client_id !== id);
      st.images = st.images.filter((i) => !ds.includes(i.design_id)); st.comments = st.comments.filter((c) => c.client_id !== id); save();
    },
    async addContact(cid, name, phone, pw, canApprove) { admin(); addUser(name, phone, pw, "client", cid, canApprove); save(); },
    async setCanApprove(id, v) { admin(); st.users.find((u) => u.id === id).can_approve = v; save(); },
    async setPassword(id, pw) { admin(); if ((pw || "").length < 6) throw new Error("الباسورد لازم يكون 6 حروف أو أرقام على الأقل"); st.users.find((u) => u.id === id).pw = pw; save(); },
    async deleteUser(id) { admin(); if (id === meId) throw new Error("مينفعش تمسح حسابك"); st.users = st.users.filter((u) => u.id !== id); save(); },
    async months(cid) {
      guard(cid);
      return wait(st.months.filter((m) => m.client_id === cid).sort((a, b) => b.period.localeCompare(a.period)).map((m) => ({ ...m, designs: st.designs.filter((d) => d.month_id === m.id).map((d) => ({ status: d.status })) })));
    },
    async month(id) { const m = st.months.find((x) => x.id === id); if (!m) throw new Error("الشهر ده مش موجود"); guard(m.client_id); return wait({ ...m, clients: { name: st.clients.find((c) => c.id === m.client_id)?.name } }); },
    async createMonth(cid, period) {
      admin(); if (st.months.some((m) => m.client_id === cid && m.period === period)) throw new Error("الشهر ده موجود بالفعل");
      const m = { id: uid(), client_id: cid, period, label: monthLabel(period), created_at: new Date().toISOString() }; st.months.push(m); save(); return m;
    },
    async deleteMonth(id) {
      admin(); const ds = st.designs.filter((d) => d.month_id === id).map((d) => d.id);
      st.months = st.months.filter((m) => m.id !== id); st.designs = st.designs.filter((d) => d.month_id !== id);
      st.images = st.images.filter((i) => !ds.includes(i.design_id)); st.comments = st.comments.filter((c) => !ds.includes(c.design_id)); save();
    },
    async designs(mid) {
      const m = st.months.find((x) => x.id === mid); guard(m.client_id);
      return wait(st.designs.filter((d) => d.month_id === mid).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)).map((d) => {
        const imgs = st.images.filter((i) => i.design_id === d.id && i.version === d.version).sort((a, b) => a.sort - b.sort);
        return { ...d, cover: imgs[0]?.url, imageCount: imgs.length, openComments: st.comments.filter((c) => c.design_id === d.id && !c.resolved && c.version === d.version).length };
      }));
    },
    async design(id) {
      const d = st.designs.find((x) => x.id === id); if (!d) throw new Error("التصميم ده مش موجود"); guard(d.client_id);
      const m = st.months.find((x) => x.id === d.month_id);
      return wait({ ...d, months: { id: m.id, label: m.label, client_id: m.client_id }, clients: { name: st.clients.find((c) => c.id === d.client_id)?.name },
        images: st.images.filter((i) => i.design_id === id).sort((a, b) => a.version - b.version || a.sort - b.sort),
        comments: st.comments.filter((c) => c.design_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
        events: st.events.filter((e) => e.design_id === id).sort((a, b) => b.at.localeCompare(a.at)) });
    },
    async createDesign(month, fields, files) {
      admin(); const urls = await readFiles(files);
      const d = { id: uid(), month_id: month.id, client_id: month.client_id, caption: "", publish_on: null, sort: 0, version: 1, status: "pending", reviewed_at: null, reviewed_by: null, created_at: new Date().toISOString(), ...fields };
      st.designs.push(d); urls.forEach((url, i) => st.images.push({ id: uid(), design_id: d.id, client_id: d.client_id, version: 1, sort: i, path: uid(), url })); save(); return d;
    },
    async updateDesign(id, f) { admin(); Object.assign(st.designs.find((d) => d.id === id), f); save(); },
    async deleteDesign(id) { admin(); st.designs = st.designs.filter((d) => d.id !== id); st.images = st.images.filter((i) => i.design_id !== id); st.comments = st.comments.filter((c) => c.design_id !== id); save(); },
    async newVersion(design, files) {
      admin(); const urls = await readFiles(files); const d = st.designs.find((x) => x.id === design.id);
      d.version++; d.status = "pending"; d.reviewed_at = null;
      urls.forEach((url, i) => st.images.push({ id: uid(), design_id: d.id, client_id: d.client_id, version: d.version, sort: i, path: uid(), url }));
      st.events.push({ id: Date.now(), design_id: d.id, client_id: d.client_id, version: d.version, action: "new_version", user_id: meId, user_name: me().name, at: new Date().toISOString() });
      save(); return d.version;
    },
    async review(id, status) {
      const d = st.designs.find((x) => x.id === id); guard(d.client_id);
      if (status === "approved" && !me().can_approve) throw new Error("الموافقة النهائية من صلاحية شخص تاني في حسابكم");
      d.status = status; d.reviewed_at = new Date().toISOString(); d.reviewed_by = meId;
      st.events.push({ id: Date.now(), design_id: id, client_id: d.client_id, version: d.version, action: status, user_id: meId, user_name: me().name, at: d.reviewed_at }); save();
    },
    async addComment(c) {
      guard(c.client_id);
      const row = { ...c, id: uid(), author_id: meId, author_name: me().name, resolved: false, resolved_at: null, created_at: new Date().toISOString() };
      st.comments.push(row); save(); return wait(row);
    },
    async deleteComment(id) { const c = st.comments.find((x) => x.id === id); guard(c.client_id); if (me().role !== "admin" && (c.author_id !== meId || c.resolved)) throw new Error("غير مسموح"); st.comments = st.comments.filter((x) => x.id !== id); save(); },
    async resolveComment(id, v) { admin(); const c = st.comments.find((x) => x.id === id); c.resolved = v; c.resolved_at = v ? new Date().toISOString() : null; save(); },
    async openComments() {
      admin();
      return wait(st.comments.filter((c) => !c.resolved).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => {
        const d = st.designs.find((x) => x.id === c.design_id); const m = st.months.find((x) => x.id === d.month_id);
        return { ...c, designs: { id: d.id, title: d.title, status: d.status, version: d.version, month_id: d.month_id, months: { label: m.label } }, clients: { id: c.client_id, name: st.clients.find((x) => x.id === c.client_id)?.name } };
      }));
    },
  };
}

let api;
try { api = DEMO ? demoApi() : supabaseApi(); }
catch (e) { app.innerHTML = `<div class="wrap"><div class="empty"><b>مش قادر أتصل بـ Supabase</b>اتأكد من الإنترنت ومن البيانات في config.js</div></div>`; throw e; }

// ------------------------------------------------------------------ state + chrome
let ME = null;
const isAdmin = () => ME?.role === "admin";
if (DEMO) $("#demoBar").classList.remove("hidden");

(function theme() {
  const root = document.documentElement; let t = null;
  try { t = localStorage.getItem("portal-theme"); } catch {}
  if (t) root.dataset.theme = t;
  $("#themeBtn").onclick = () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("portal-theme", root.dataset.theme); } catch {}
  };
})();

$("#logoutBtn").onclick = async () => { await api.signOut(); ME = null; location.hash = "#/"; route(); };
function chrome() {
  $("#who").textContent = ME ? ME.name : "";
  $("#logoutBtn").classList.toggle("hidden", !ME);
}

// ------------------------------------------------------------------ router
let renderId = 0;
async function route() {
  const id = ++renderId;
  const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  try {
    if (ME === null) ME = await api.me().catch(() => null);
    chrome();
    if (!ME) return renderLogin();
    app.innerHTML = loadingHTML;
    const [view, arg] = parts;
    const stale = () => id !== renderId;
    if (view === "m" && arg) return await renderMonth(arg, stale);
    if (view === "d" && arg) return await renderDesign(arg, stale);
    if (isAdmin()) {
      if (view === "c" && arg) return await renderClient(arg, stale);
      if (view === "inbox") return await renderInbox(stale);
      return await renderAdminHome(stale);
    }
    return await renderClientHome(stale);
  } catch (e) {
    fail(e);
    if (/انتهت الجلسة|JWT/i.test(friendlyError(e))) { ME = null; return renderLogin(); }
    app.innerHTML = `<div class="wrap"><div class="empty"><b>حصلت مشكلة</b>${esc(friendlyError(e))}<br><br><a class="btn" href="#/">رجوع للرئيسية</a></div></div>`;
  }
}
window.addEventListener("hashchange", route);

const crumbs = (items) => `<nav class="crumbs" aria-label="مسار الصفحة">${items.map((it, i) => i < items.length - 1 ? `<a href="${it[1]}">${esc(it[0])}</a><span>›</span>` : `<span>${esc(it[0])}</span>`).join("")}</nav>`;
const countStatus = (ds) => ({ total: ds.length, approved: ds.filter((d) => d.status === "approved").length, changes: ds.filter((d) => d.status === "changes").length, pending: ds.filter((d) => d.status === "pending").length });
const progressBar = (c) => c.total ? `<div class="progress" role="img" aria-label="${c.approved} من ${c.total} اتوافق عليهم"><i class="p-ok" style="width:${c.approved / c.total * 100}%"></i><i class="p-ch" style="width:${c.changes / c.total * 100}%"></i></div>` : "";

// ------------------------------------------------------------------ login
function renderLogin() {
  app.innerHTML = `<div class="login"><div class="card">
    <div class="logo">TR</div>
    <h1 style="text-align:center">أهلاً بيك</h1>
    <p class="muted" style="text-align:center;margin:4px 0 20px">ادخل برقم موبايلك والباسورد اللي وصلك من ترند عشان تراجع تصميماتك.</p>
    <form class="form" id="loginForm" novalidate>
      <label class="f">رقم الموبايل<input class="input" name="phone" type="tel" inputmode="tel" autocomplete="username" placeholder="01012345678" dir="ltr" required></label>
      <label class="f">الباسورد<input class="input" name="pw" type="password" autocomplete="current-password" dir="ltr" required></label>
      <div class="err" id="loginErr"></div>
      <button class="btn primary block">دخول</button>
      <p class="small muted" style="margin:0;text-align:center">نسيت الباسورد؟ كلم ترند على واتساب وهنعملك واحد جديد.</p>
    </form>
    ${DEMO ? `<div class="demo-acc" style="margin-top:18px"><b>حسابات التجربة (الباسورد 123456):</b>
      <span>عميل: <button data-demo="01111111111">01111111111</button> · أدمن: <button data-demo="01000000000">01000000000</button></span>
      <span>عميل بدون صلاحية موافقة: <button data-demo="01011111111">01011111111</button></span>
      <span><button id="demoReset">رجّع بيانات التجربة لأولها</button></span></div>` : ""}
  </div></div>`;
  const f = $("#loginForm");
  f.onsubmit = async (e) => {
    e.preventDefault(); $("#loginErr").textContent = "";
    const btn = $("button", f); btn.disabled = true;
    try { ME = await api.signIn(f.phone.value, f.pw.value); location.hash = "#/"; route(); }
    catch (err) { $("#loginErr").textContent = friendlyError(err); }
    finally { btn.disabled = false; }
  };
  $$("[data-demo]").forEach((b) => b.onclick = () => { f.phone.value = b.dataset.demo; f.pw.value = "123456"; f.requestSubmit(); });
  $("#demoReset")?.addEventListener("click", () => { api.reset(); toast("رجعت بيانات التجربة لأولها"); });
}

// ------------------------------------------------------------------ client home: months
async function renderClientHome(stale) {
  const [client, months] = await Promise.all([api.client(ME.client_id), api.months(ME.client_id)]);
  if (stale()) return;
  const all = months.flatMap((m) => m.designs);
  const waiting = all.filter((d) => d.status === "pending").length;
  app.innerHTML = `<main class="wrap">
    <div class="pagehead"><div class="grow"><p class="muted" style="margin:0">${esc(client.name)}</p><h1>تصميمات كل شهر</h1></div></div>
    ${waiting ? `<div class="notice warn" style="margin-bottom:16px">عندك <b>${waiting}</b> ${waiting === 1 ? "تصميم مستني" : "تصميمات مستنية"} مراجعتك.</div>` : ""}
    ${months.length ? `<div class="list">${months.map(monthItem).join("")}</div>` :
      `<div class="card empty"><b>لسه مفيش تصميمات</b>أول ما فريق ترند يرفع تصميمات الشهر هتلاقيها هنا.</div>`}
  </main>`;
}
function monthItem(m) {
  const c = countStatus(m.designs);
  const parts = [];
  if (c.pending) parts.push(`<span class="badge b-pending">${c.pending} ${isAdmin() ? "مستني العميل" : "مستني مراجعتك"}</span>`);
  if (c.changes) parts.push(`<span class="badge b-changes">${c.changes} مطلوب تعديل</span>`);
  if (c.total && c.approved === c.total) parts.push(`<span class="badge b-approved">الشهر كله اتوافق عليه</span>`);
  return `<a class="card item" href="#/m/${m.id}">
    <div class="avatar" aria-hidden="true">${esc(m.label.split(" ")[0].slice(0, 2))}</div>
    <div class="grow"><h3>${esc(m.label)}</h3>
      <div class="row small muted" style="gap:6px;margin-top:2px"><span>${c.total} تصميم · ${c.approved} اتوافق عليه</span>${parts.join("")}</div>
      ${progressBar(c)}</div>
    <span class="muted" aria-hidden="true">‹</span></a>`;
}

// ------------------------------------------------------------------ month page (client + admin)
async function renderMonth(id, stale) {
  const [month, designs] = await Promise.all([api.month(id), api.designs(id)]);
  if (stale()) return;
  const c = countStatus(designs);
  const back = isAdmin() ? [["العملاء", "#/"], [month.clients?.name || "العميل", `#/c/${month.client_id}`], [month.label, ""]] : [["الشهور", "#/"], [month.label, ""]];
  app.innerHTML = `<main class="wrap">
    ${crumbs(back)}
    <div class="pagehead"><div class="grow"><h1>${esc(month.label)}</h1>
      <p class="muted" style="margin:2px 0 0">${c.total} تصميم · ${c.approved} اتوافق عليه · ${c.changes} مطلوب تعديل · ${c.pending} ${isAdmin() ? "مستني العميل" : "مستني مراجعتك"}</p>
      <div style="max-width:360px">${progressBar(c)}</div></div>
      ${isAdmin() ? `<div class="row"><button class="btn primary" id="addDesign">+ تصميم</button><button class="btn" id="bulkAdd">رفع كذا تصميم مرة واحدة</button><button class="btn ghost danger" id="delMonth">مسح الشهر</button></div>` : ""}
    </div>
    ${designs.length ? `<div class="grid">${designs.map(designCard).join("")}</div>` :
      `<div class="card empty"><b>الشهر ده لسه فاضي</b>${isAdmin() ? "ارفع التصميمات من الزرار اللي فوق." : "أول ما التصميمات تترفع هتظهر هنا."}</div>`}
  </main>`;
  if (!isAdmin()) return;
  $("#addDesign").onclick = () => addDesignDialog(month, designs.length);
  $("#bulkAdd").onclick = () => bulkDialog(month, designs.length);
  $("#delMonth").onclick = async () => {
    if (!await confirmBox("مسح الشهر", `هيتمسح ${esc(month.label)} بكل التصميمات والتعليقات اللي فيه. متأكد؟`, "امسح", "warn")) return;
    try { await api.deleteMonth(id); toast("الشهر اتمسح"); location.hash = `#/c/${month.client_id}`; } catch (e) { fail(e); }
  };
}
function designCard(d) {
  return `<a class="card dcard" href="#/d/${d.id}">
    <div class="thumb">${d.cover ? `<img src="${esc(d.cover)}" alt="" loading="lazy" draggable="false">` : ""}
      ${d.status !== "approved" ? `<div class="wm"></div>` : ""}
      ${d.imageCount > 1 ? `<span class="count">${d.imageCount} صور</span>` : ""}
      ${d.version > 1 ? `<span class="ver">نسخة ${d.version}</span>` : ""}</div>
    <div class="meta"><h3>${esc(d.title)}</h3>
      <div class="row" style="gap:6px">${badge(d.status)}${d.openComments ? `<span class="chip">${d.openComments} تعديل</span>` : ""}${d.publish_on ? `<span class="chip">نشر ${fmtDate(d.publish_on)}</span>` : ""}</div></div>
  </a>`;
}
function designFields(d = {}) {
  return `<label class="f">اسم التصميم<input class="input" name="title" required maxlength="120" value="${esc(d.title || "")}" placeholder="مثلاً: عرض الويك إند"></label>
    <div class="two"><label class="f">ميعاد النشر (اختياري)<input class="input" type="date" name="publish_on" value="${esc(d.publish_on || "")}"></label>
    <label class="f">الترتيب<input class="input" type="number" name="sort" value="${esc(d.sort ?? 0)}"></label></div>
    <label class="f">الكابشن<textarea class="input" name="caption" rows="4" placeholder="النص اللي هيتنشر مع البوست">${esc(d.caption || "")}</textarea></label>`;
}
const fileInput = (label) => `<label class="f">${label}<input class="input" type="file" name="files" accept="image/*" multiple required></label>
  <p class="small muted" style="margin:-4px 0 0">لو بوست كاروسيل اختار كل الصور مرة واحدة، وهتظهر بنفس ترتيب أسماء الملفات.</p>`;
const sortedFiles = (input) => [...input.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
function addDesignDialog(month, n) {
  openDialog("تصميم جديد", designFields({ sort: n }) + fileInput("الصور"), {
    okText: "ارفع", onOk: async (f) => {
      if (!f.title.value.trim()) throw new Error("اكتب اسم التصميم");
      if (!f.files.files.length) throw new Error("اختار صورة واحدة على الأقل");
      await api.createDesign(month, { title: f.title.value.trim(), caption: f.caption.value, publish_on: f.publish_on.value || null, sort: +f.sort.value || 0 }, sortedFiles(f.files));
      toast("التصميم اترفع"); route();
    } });
}
function bulkDialog(month, n) {
  openDialog("رفع تصميمات الشهر مرة واحدة", `<p class="muted" style="margin:0">اختار كل صور الشهر. كل صورة هتبقى تصميم لوحدها، واسمه هو اسم الملف. تقدر تعدّل الأسامي والكابشن بعدين.</p>
    <label class="f">الصور<input class="input" type="file" name="files" accept="image/*" multiple required></label><div class="small muted" data-prog></div>`, {
    okText: "ارفع الكل", onOk: async (f) => {
      const files = sortedFiles(f.files);
      if (!files.length) throw new Error("اختار الصور الأول");
      const prog = $("[data-prog]", dlg);
      for (let i = 0; i < files.length; i++) {
        prog.textContent = `بيرفع ${i + 1} من ${files.length}…`;
        const title = files[i].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || `تصميم ${n + i + 1}`;
        await api.createDesign(month, { title, caption: "", publish_on: null, sort: n + i }, [files[i]]);
      }
      toast(`اترفع ${files.length} تصميم`); route();
    } });
}

// ------------------------------------------------------------------ design page (the heart)
const view = { designId: null, version: null, img: 0, draft: null, active: null };
async function renderDesign(id, stale) {
  const d = await api.design(id);
  if (stale()) return;
  if (view.designId !== id) Object.assign(view, { designId: id, version: d.version, img: 0, draft: null, active: null });
  if (view.version > d.version) view.version = d.version;
  drawDesign(d);
}
function drawDesign(d) {
  const ver = view.version;
  const isCurrent = ver === d.version;
  const imgs = d.images.filter((i) => i.version === ver);
  if (view.img >= imgs.length) view.img = 0;
  const cmts = d.comments.filter((c) => c.version === ver);
  const versions = [...new Set(d.images.map((i) => i.version))].sort((a, b) => a - b);
  const canComment = isCurrent && (isAdmin() || d.status !== "approved");
  const openCount = cmts.filter((c) => !c.resolved).length;
  const cur = imgs[view.img];
  const numbered = cmts.map((c, i) => ({ ...c, n: i + 1 }));
  const pins = numbered.filter((c) => c.x != null && (c.img_index ?? 0) === view.img);
  const back = isAdmin()
    ? [["العملاء", "#/"], [d.clients?.name || "العميل", `#/c/${d.months.client_id}`], [d.months.label, `#/m/${d.month_id}`], [d.title, ""]]
    : [["الشهور", "#/"], [d.months.label, `#/m/${d.month_id}`], [d.title, ""]];

  app.innerHTML = `<main class="wrap">
    ${crumbs(back)}
    <div class="pagehead"><div class="grow"><h1>${esc(d.title)}</h1>
      <div class="row small muted" style="gap:6px;margin-top:4px">${badge(d.status)}
        ${d.publish_on ? `<span class="chip">ميعاد النشر ${fmtDate(d.publish_on)}</span>` : ""}
        ${d.version > 1 ? `<span class="chip">نسخة ${d.version}</span>` : ""}</div></div>
      ${isAdmin() ? `<div class="row"><button class="btn primary" id="newVer">رفع نسخة بعد التعديل</button><button class="btn" id="editD">تعديل البيانات</button><button class="btn ghost danger" id="delD">مسح</button></div>` : ""}
    </div>
    <div class="dlayout">
      <section class="card stagebox" aria-label="التصميم">
        ${versions.length > 1 ? `<div class="row small"><span class="muted">النسخ:</span><div class="vers">${versions.map((v) => `<button data-ver="${v}" class="${v === ver ? "on" : ""}">${v === d.version ? `الحالية (${v})` : `نسخة ${v}`}</button>`).join("")}</div></div>` : ""}
        ${!isCurrent ? `<div class="notice info">بتتفرج على نسخة قديمة (${ver}). التعليقات هنا للقراية بس.</div>` : ""}
        <div class="stage">
          ${imgs.length > 1 ? `<button class="btn iconbtn navarrow prev" data-nav="-1" aria-label="الصورة اللي قبل">›</button><button class="btn iconbtn navarrow next" data-nav="1" aria-label="الصورة اللي بعد">‹</button>` : ""}
          ${cur ? `<div class="imgwrap ${canComment ? "can-pin" : ""}" id="imgwrap">
            <img src="${esc(cur.url || "")}" alt="${esc(d.title)}" draggable="false" id="mainImg">
            ${d.status !== "approved" ? `<div class="wm"></div>` : ""}
            ${pins.map((c) => `<button class="pin ${c.resolved ? "done" : ""} ${view.active === c.id ? "active" : ""}" style="left:${c.x}%;top:${c.y}%" data-pin="${c.id}" aria-label="تعديل رقم ${c.n}">${c.n}</button>`).join("")}
            ${view.draft && view.draft.img === view.img && view.draft.x != null ? `<span class="pin draft" style="left:${view.draft.x}%;top:${view.draft.y}%">${numbered.length + 1}</span>` : ""}
          </div>` : `<div class="empty">مفيش صور في النسخة دي</div>`}
        </div>
        ${imgs.length > 1 ? `<div class="dots">${imgs.map((_, i) => `<button data-dot="${i}" class="${i === view.img ? "on" : ""}" aria-label="صورة ${i + 1}"></button>`).join("")}</div>` : ""}
        ${canComment ? `<p class="hint">👆 اضغط على أي مكان في التصميم عشان تكتب التعديل عليه بالظبط</p>` : ""}
        ${d.caption ? `<div><h3 style="margin-bottom:6px">الكابشن</h3><div class="caption">${esc(d.caption)}</div></div>` : ""}
      </section>

      <aside class="side sticky">
        ${reviewPanel(d, isCurrent, openCount)}
        <div class="card">
          <div class="row" style="margin-bottom:10px"><h2>التعديلات ${cmts.length ? `<span class="muted small">(${openCount} مفتوح)</span>` : ""}</h2><div class="spacer"></div>
            ${canComment && !view.draft ? `<button class="btn sm" id="generalCmt">+ تعديل عام</button>` : ""}</div>
          ${view.draft ? draftForm(numbered.length + 1) : ""}
          <div class="comments">${numbered.length ? numbered.map((c) => commentItem(c, d, isCurrent)).join("") :
            (view.draft ? "" : `<p class="muted small" style="margin:0">${canComment ? "مفيش تعديلات لحد دلوقتي. لو التصميم محتاج حاجة اضغط عليه واكتبها." : "مفيش تعديلات على النسخة دي."}</p>`)}</div>
        </div>
        ${d.events.length ? `<div class="card"><h3 style="margin-bottom:8px">السجل</h3><div class="events">${d.events.map(eventRow).join("")}</div></div>` : ""}
      </aside>
    </div>
  </main>`;
  bindDesign(d, imgs, canComment, numbered);
}
function reviewPanel(d, isCurrent, openCount) {
  if (!isCurrent) return "";
  if (isAdmin()) {
    const st = { pending: ["info", "مستني العميل يراجع التصميم."], changes: ["warn", `العميل طلب تعديلات. علّم على كل تعديل "اتنفذ" وبعدين ارفع نسخة جديدة.`], approved: ["ok", `العميل وافق ${fmtDateTime(d.reviewed_at)}.`] }[d.status];
    return `<div class="card"><div class="notice ${st[0]}">${st[1]}</div></div>`;
  }
  if (d.status === "approved") return `<div class="card"><div class="notice ok">✅ وافقت على التصميم ده ${fmtDateTime(d.reviewed_at)}. شكراً!</div></div>`;
  const waitingNew = d.status === "changes";
  return `<div class="card reviewbar">
    ${waitingNew ? `<div class="notice warn">بعتّ التعديلات، وفريق ترند شغال عليها. تقدر تزود تعديلات تانية لو حابب.</div>` : `<h2>رأيك في التصميم؟</h2>`}
    ${ME.can_approve ? `<button class="btn ok block" id="approveBtn">✅ موافق على التصميم</button>` : `<p class="small muted" style="margin:0">الموافقة النهائية من صلاحية شخص تاني في حسابكم. تقدر تكتب تعديلاتك عادي.</p>`}
    ${!waitingNew ? `<button class="btn warn block" id="changesBtn" ${openCount ? "" : "disabled"}>✏️ ابعت التعديلات${openCount ? ` (${openCount})` : ""}</button>
      ${openCount ? "" : `<p class="small muted" style="margin:0">اكتب التعديلات الأول (اضغط على التصميم)، وبعدين ابعتها مرة واحدة.</p>`}` :
      `<button class="btn block" id="waBtn">📲 بلّغ ترند على واتساب</button>`}
  </div>`;
}
function draftForm(n) {
  const d = view.draft;
  return `<form class="draftbox" id="draftForm" novalidate style="margin-bottom:10px">
    <div class="row"><span class="num ${d.x == null ? "gen" : ""}">${n}</span><b>${d.x == null ? "تعديل عام على التصميم" : "تعديل على النقطة دي"}</b></div>
    <div class="cats" role="radiogroup" aria-label="نوع التعديل">${Object.entries(CATS).map(([k, v]) => `<label><input type="radio" name="cat" value="${k}" ${k === (d.cat || (d.x == null ? "caption" : "text")) ? "checked" : ""}><span>${v}</span></label>`).join("")}</div>
    <textarea class="input" name="body" rows="3" placeholder="اكتب التعديل المطلوب بالظبط… مثلاً: كبّر اللوجو، أو غيّر السعر لـ 499" required></textarea>
    <div class="row"><button class="btn primary sm">حفظ التعديل</button><button type="button" class="btn ghost sm" id="cancelDraft">إلغاء</button></div>
  </form>`;
}
function commentItem(c, d, isCurrent) {
  const mine = c.author_id === ME.id;
  const canDel = isCurrent && (isAdmin() || (mine && !c.resolved && d.status !== "approved"));
  return `<div class="cmt ${c.resolved ? "done" : ""} ${view.active === c.id ? "active" : ""}" data-cmt="${c.id}">
    <div class="head"><span class="num ${c.resolved ? "done" : c.x == null ? "gen" : ""}">${c.n}</span>
      <span class="chip">${CATS[c.category] || c.category}</span>
      ${c.x != null && (c.img_index ?? 0) > 0 ? `<span class="chip">صورة ${(c.img_index ?? 0) + 1}</span>` : ""}
      <span class="spacer"></span><span>${esc(c.author_name)} · ${fmtDateTime(c.created_at)}</span></div>
    <div class="body">${esc(c.body)}</div>
    <div class="row" style="gap:6px">
      ${c.resolved ? `<span class="small" style="color:var(--ok)">✓ اتنفذ</span>` : ""}
      <span class="spacer"></span>
      ${isAdmin() && isCurrent ? `<button class="btn sm" data-resolve="${c.id}" data-v="${c.resolved ? 0 : 1}">${c.resolved ? "رجّعه مفتوح" : "✓ اتنفذ"}</button>` : ""}
      ${canDel ? `<button class="btn ghost sm danger" data-del="${c.id}">مسح</button>` : ""}
    </div></div>`;
}
const EVENT_TXT = { approved: "✅ وافق على التصميم", changes: "✏️ طلب تعديلات", new_version: "⬆️ رفع نسخة جديدة" };
const eventRow = (e) => `<div><time>${fmtDateTime(e.at)}</time><span>${esc(e.user_name)}: ${EVENT_TXT[e.action] || esc(e.action)} <span class="muted">(نسخة ${e.version})</span></span></div>`;

function bindDesign(d, imgs, canComment, numbered) {
  const redraw = () => drawDesign(d);
  $$("[data-ver]").forEach((b) => b.onclick = () => { view.version = +b.dataset.ver; view.img = 0; view.draft = null; view.active = null; redraw(); });
  $$("[data-nav]").forEach((b) => b.onclick = () => { view.img = (view.img + +b.dataset.nav + imgs.length) % imgs.length; redraw(); });
  $$("[data-dot]").forEach((b) => b.onclick = () => { view.img = +b.dataset.dot; redraw(); });
  const img = $("#mainImg");
  img?.addEventListener("contextmenu", (e) => e.preventDefault());
  if (canComment && img) {
    $("#imgwrap").addEventListener("click", (e) => {
      if (e.target.closest(".pin")) return;
      const r = img.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100));
      const y = Math.min(100, Math.max(0, (e.clientY - r.top) / r.height * 100));
      view.draft = { x: +x.toFixed(2), y: +y.toFixed(2), img: view.img }; view.active = null; redraw();
      setTimeout(() => { const t = $("#draftForm textarea"); t?.focus({ preventScroll: true }); $("#draftForm")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 20);
    });
  }
  $$("[data-pin]").forEach((p) => p.onclick = (e) => { e.stopPropagation(); view.active = p.dataset.pin; redraw(); $(`[data-cmt="${p.dataset.pin}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
  $$("[data-cmt]").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const c = numbered.find((x) => x.id === el.dataset.cmt);
    view.active = c.id; if (c.x != null) view.img = c.img_index ?? 0; redraw();
  }));
  $("#generalCmt")?.addEventListener("click", () => { view.draft = { x: null, y: null, img: null }; redraw(); setTimeout(() => $("#draftForm textarea")?.focus(), 20); });
  $("#cancelDraft")?.addEventListener("click", () => { view.draft = null; redraw(); });
  const df = $("#draftForm");
  if (df) {
    df.cat.forEach?.((r) => r.addEventListener("change", () => { view.draft.cat = r.value; }));
    df.onsubmit = async (e) => {
      e.preventDefault();
      const body = df.body.value.trim();
      if (!body) { df.body.focus(); toast("اكتب التعديل الأول", { bad: true }); return; }
      const btn = $("button", df); btn.disabled = true;
      try {
        const dr = view.draft;
        const row = await api.addComment({ design_id: d.id, client_id: d.client_id, version: d.version, img_index: dr.x == null ? null : dr.img, x: dr.x, y: dr.y, category: df.cat.value, body, author_id: ME.id });
        d.comments.push(row); view.draft = null; view.active = row.id; redraw(); toast("التعديل اتسجل");
      } catch (err) { fail(err); btn.disabled = false; }
    };
  }
  $$("[data-del]").forEach((b) => b.onclick = async () => {
    if (!await confirmBox("مسح التعديل", "متأكد إنك عايز تمسح التعديل ده؟", "امسح", "warn")) return;
    try { await api.deleteComment(b.dataset.del); d.comments = d.comments.filter((c) => c.id !== b.dataset.del); redraw(); } catch (e) { fail(e); }
  });
  $$("[data-resolve]").forEach((b) => b.onclick = async () => {
    const v = b.dataset.v === "1";
    try { await api.resolveComment(b.dataset.resolve, v); const c = d.comments.find((x) => x.id === b.dataset.resolve); c.resolved = v; redraw(); } catch (e) { fail(e); }
  });
  $("#approveBtn")?.addEventListener("click", async () => {
    const open = d.comments.filter((c) => c.version === d.version && !c.resolved).length;
    const ok = await confirmBox("موافقة على التصميم", `هتوافق على "${esc(d.title)}" وهيتجهز للنشر.${open ? `<br><br><b>ملحوظة:</b> فيه ${open} تعديل مكتوب، الموافقة معناها إن التصميم ينزل زي ما هو.` : ""}`, "✅ موافق", "ok");
    if (!ok) return;
    try { await api.review(d.id, "approved"); toast("شكراً! التصميم اتوافق عليه"); route(); } catch (e) { fail(e); }
  });
  $("#changesBtn")?.addEventListener("click", async () => {
    try { await api.review(d.id, "changes"); route(); setTimeout(() => toast(`التعديلات وصلت لفريق ترند. <a href="${waLink(d)}" target="_blank" rel="noopener">بلّغهم على واتساب</a>`, { ms: 9000 }), 300); }
    catch (e) { fail(e); }
  });
  $("#waBtn")?.addEventListener("click", () => window.open(waLink(d), "_blank", "noopener"));
  if (isAdmin()) {
    $("#editD").onclick = () => openDialog("تعديل بيانات التصميم", designFields(d), { onOk: async (f) => {
      if (!f.title.value.trim()) throw new Error("اكتب اسم التصميم");
      await api.updateDesign(d.id, { title: f.title.value.trim(), caption: f.caption.value, publish_on: f.publish_on.value || null, sort: +f.sort.value || 0 });
      toast("اتحفظ"); route(); } });
    $("#newVer").onclick = () => openDialog("رفع نسخة بعد التعديل", `<p class="muted" style="margin:0">النسخة الجديدة هتبقى نسخة ${d.version + 1}، وحالة التصميم هترجع "مستني العميل". النسخ القديمة وتعليقاتها هتفضل موجودة للمقارنة.</p>` + fileInput("صور النسخة الجديدة"), {
      okText: "ارفع", onOk: async (f) => {
        if (!f.files.files.length) throw new Error("اختار الصور");
        await api.newVersion(d, sortedFiles(f.files)); view.designId = null; toast("النسخة الجديدة اترفعت"); route();
      } });
    $("#delD").onclick = async () => {
      if (!await confirmBox("مسح التصميم", `هيتمسح "${esc(d.title)}" بكل نسخه وتعليقاته. متأكد؟`, "امسح", "warn")) return;
      try { await api.deleteDesign(d.id); toast("التصميم اتمسح"); location.hash = `#/m/${d.month_id}`; } catch (e) { fail(e); }
    };
  }
}
function waLink(d) {
  const open = d.comments.filter((c) => c.version === d.version && !c.resolved);
  const lines = open.map((c, i) => `${i + 1}. [${CATS[c.category]}] ${c.body}`).join("\n");
  const msg = `أهلاً فريق ترند 👋\nبعتّ تعديلات على تصميم "${d.title}" (${d.months.label}) في بوابة المراجعة:\n${lines}\n\n${location.href}`;
  return `https://wa.me/${CFG.AGENCY_WHATSAPP}?text=${encodeURIComponent(msg)}`;
}

// ------------------------------------------------------------------ admin: home
async function renderAdminHome(stale) {
  const clients = await api.overview();
  if (stale()) return;
  const all = clients.flatMap((c) => c.designs);
  const s = countStatus(all);
  const open = clients.reduce((a, c) => a + c.open, 0);
  app.innerHTML = `<main class="wrap">
    <div class="pagehead"><div class="grow"><h1>لوحة التحكم</h1><p class="muted" style="margin:0">كل العملاء والتصميمات في مكان واحد.</p></div>
      <div class="row"><a class="btn" href="#/inbox">التعديلات المفتوحة${open ? ` (${open})` : ""}</a><button class="btn primary" id="addClient">+ عميل جديد</button></div></div>
    <div class="stats">
      <div class="card stat"><b>${clients.length}</b><span>عميل</span></div>
      <div class="card stat"><b>${s.pending}</b><span>مستني العميل</span></div>
      <div class="card stat hl"><b>${s.changes}</b><span>مطلوب تعديل</span></div>
      <div class="card stat"><b>${open}</b><span>تعديل لسه ما اتنفذش</span></div>
    </div>
    <div class="section"><div class="row"><h2>العملاء</h2></div>
    ${clients.length ? `<div class="list">${clients.map((c) => { const k = countStatus(c.designs); return `<a class="card item" href="#/c/${c.id}">
      <div class="avatar" aria-hidden="true">${esc(c.name.trim().slice(0, 1))}</div>
      <div class="grow"><h3>${esc(c.name)}</h3><div class="row small muted" style="gap:6px;margin-top:2px"><span>${k.total} تصميم</span>
        ${k.pending ? `<span class="badge b-pending">${k.pending} مستني</span>` : ""}${k.changes ? `<span class="badge b-changes">${k.changes} تعديل</span>` : ""}${c.open ? `<span class="chip">${c.open} ملاحظة مفتوحة</span>` : ""}</div>${progressBar(k)}</div>
      <span class="muted" aria-hidden="true">‹</span></a>`; }).join("")}</div>`
      : `<div class="card empty"><b>لسه مفيش عملاء</b>ابدأ بإضافة أول عميل، وابعتله رقمه والباسورد.</div>`}</div>
  </main>`;
  $("#addClient").onclick = () => openDialog("عميل جديد", `
    <label class="f">اسم العميل / البيزنس<input class="input" name="cname" required placeholder="مثلاً: مطعم الشرقاوي"></label>
    <label class="f">اسم الشخص المسؤول<input class="input" name="contact" required placeholder="مثلاً: أحمد"></label>
    <div class="two"><label class="f">رقم الموبايل (للدخول)<input class="input" name="phone" type="tel" dir="ltr" required placeholder="01012345678"></label>
    <label class="f">الباسورد<input class="input" name="pw" dir="ltr" required minlength="6" value="${genPw()}"></label></div>
    <p class="small muted" style="margin:0">ابعت للعميل الرقم والباسورد ولينك الموقع. تقدر تغيّر الباسورد في أي وقت.</p>`, {
    okText: "أضف العميل", onOk: async (f) => {
      if (!f.cname.value.trim() || !f.contact.value.trim()) throw new Error("اكتب اسم العميل واسم المسؤول");
      if (!normalizePhone(f.phone.value)) throw new Error("رقم الموبايل غير صحيح");
      const id = await api.createClient(f.cname.value.trim(), f.contact.value.trim(), f.phone.value, f.pw.value);
      shareCreds(f.contact.value.trim(), f.phone.value, f.pw.value);
      location.hash = `#/c/${id}`;
    } });
}
const genPw = () => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; let s = ""; const r = crypto.getRandomValues(new Uint32Array(8)); for (const n of r) s += a[n % a.length]; return s; };
function shareCreds(name, phone, pw) {
  const link = location.href.split("#")[0];
  const msg = `أهلاً ${name} 👋\nده لينك مراجعة التصميمات الخاص بيك من ترند:\n${link}\n\nرقم الدخول: ${prettyPhone(normalizePhone(phone))}\nالباسورد: ${pw}`;
  const n = normalizePhone(phone);
  setTimeout(() => toast(`الحساب اتعمل. <a href="https://wa.me/${n}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">ابعت البيانات للعميل على واتساب</a>`, { ms: 12000 }), 200);
}

// ------------------------------------------------------------------ admin: client page
async function renderClient(id, stale) {
  const [c, months, people] = await Promise.all([api.client(id), api.months(id), api.contacts(id)]);
  if (stale()) return;
  app.innerHTML = `<main class="wrap">
    ${crumbs([["العملاء", "#/"], [c.name, ""]])}
    <div class="pagehead"><div class="grow"><h1>${esc(c.name)}</h1></div>
      <div class="row"><button class="btn primary" id="addMonth">+ شهر جديد</button><button class="btn" id="renameC">تغيير الاسم</button><button class="btn ghost danger" id="delC">مسح العميل</button></div></div>
    <div class="section"><div class="row"><h2>الشهور</h2></div>
      ${months.length ? `<div class="list">${months.map(monthItem).join("")}</div>` : `<div class="card empty"><b>مفيش شهور لسه</b>اضغط "شهر جديد" وارفع تصميماته.</div>`}</div>
    <div class="section"><div class="row"><h2>الأشخاص اللي بيدخلوا</h2><div class="spacer"></div><button class="btn sm" id="addPerson">+ شخص</button></div>
      <div class="list">${people.map((p) => `<div class="card item">
        <div class="avatar" aria-hidden="true">${esc(p.name.trim().slice(0, 1))}</div>
        <div class="grow"><h3>${esc(p.name)}</h3><div class="small muted" dir="ltr" style="text-align:right">${esc(prettyPhone(p.phone))}</div>
          <label class="check small" style="margin-top:4px"><input type="checkbox" data-approve="${p.id}" ${p.can_approve ? "checked" : ""}> من حقه يوافق موافقة نهائية</label></div>
        <div class="row" style="gap:6px"><button class="btn sm" data-pw="${p.id}" data-name="${esc(p.name)}" data-phone="${esc(p.phone)}">باسورد جديد</button><button class="btn ghost sm danger" data-deluser="${p.id}">مسح</button></div>
      </div>`).join("")}</div></div>
  </main>`;
  $("#addMonth").onclick = () => {
    const now = new Date(); const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const val = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    openDialog("شهر جديد", `<label class="f">الشهر<input class="input" type="month" name="m" required value="${val}"></label>`, {
      okText: "أضف", onOk: async (f) => { if (!f.m.value) throw new Error("اختار الشهر"); const m = await api.createMonth(id, f.m.value + "-01"); location.hash = `#/m/${m.id}`; } });
  };
  $("#renameC").onclick = () => openDialog("اسم العميل", `<label class="f">الاسم<input class="input" name="n" required value="${esc(c.name)}"></label>`, {
    onOk: async (f) => { if (!f.n.value.trim()) throw new Error("اكتب الاسم"); await api.renameClient(id, f.n.value.trim()); route(); } });
  $("#delC").onclick = async () => {
    if (!await confirmBox("مسح العميل", `هيتمسح "${esc(c.name)}" بكل شهوره وتصميماته وحسابات الدخول بتاعته. الخطوة دي مالهاش رجوع.`, "امسح نهائياً", "warn")) return;
    try { await api.deleteClient(id); toast("العميل اتمسح"); location.hash = "#/"; } catch (e) { fail(e); }
  };
  $("#addPerson").onclick = () => openDialog("شخص جديد يدخل على حساب " + esc(c.name), `
    <label class="f">الاسم<input class="input" name="n" required placeholder="مثلاً: منى – ماركتينج"></label>
    <div class="two"><label class="f">رقم الموبايل<input class="input" name="phone" type="tel" dir="ltr" required></label>
    <label class="f">الباسورد<input class="input" name="pw" dir="ltr" required value="${genPw()}"></label></div>
    <label class="check"><input type="checkbox" name="ap" checked> من حقه يوافق موافقة نهائية (لو مش متعلّم يقدر يكتب تعديلات بس)</label>`, {
    okText: "أضف", onOk: async (f) => {
      if (!f.n.value.trim()) throw new Error("اكتب الاسم");
      if (!normalizePhone(f.phone.value)) throw new Error("رقم الموبايل غير صحيح");
      await api.addContact(id, f.n.value.trim(), f.phone.value, f.pw.value, f.ap.checked);
      shareCreds(f.n.value.trim(), f.phone.value, f.pw.value); route();
    } });
  $$("[data-approve]").forEach((cb) => cb.onchange = async () => { try { await api.setCanApprove(cb.dataset.approve, cb.checked); toast("اتحفظ"); } catch (e) { cb.checked = !cb.checked; fail(e); } });
  $$("[data-pw]").forEach((b) => b.onclick = () => openDialog("باسورد جديد لـ " + esc(b.dataset.name), `<label class="f">الباسورد الجديد<input class="input" name="pw" dir="ltr" required value="${genPw()}"></label>`, {
    onOk: async (f) => { await api.setPassword(b.dataset.pw, f.pw.value); shareCreds(b.dataset.name, prettyPhone(b.dataset.phone), f.pw.value); } }));
  $$("[data-deluser]").forEach((b) => b.onclick = async () => {
    if (!await confirmBox("مسح الشخص", "الشخص ده مش هيقدر يدخل تاني. تعليقاته القديمة هتفضل موجودة.", "امسح", "warn")) return;
    try { await api.deleteUser(b.dataset.deluser); route(); } catch (e) { fail(e); }
  });
}

// ------------------------------------------------------------------ admin: inbox of open changes
async function renderInbox(stale) {
  const rows = await api.openComments();
  if (stale()) return;
  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.clients.id)) byClient.set(r.clients.id, { name: r.clients.name, designs: new Map() });
    const g = byClient.get(r.clients.id);
    if (!g.designs.has(r.design_id)) g.designs.set(r.design_id, { d: r.designs, items: [] });
    g.designs.get(r.design_id).items.push(r);
  }
  app.innerHTML = `<main class="wrap">
    ${crumbs([["العملاء", "#/"], ["التعديلات المفتوحة", ""]])}
    <div class="pagehead"><div class="grow"><h1>التعديلات المفتوحة</h1><p class="muted" style="margin:0">كل التعديلات اللي العملاء طلبوها ولسه ما اتعلمش عليها "اتنفذ".</p></div></div>
    ${rows.length ? `<div class="list">${[...byClient.values()].map((g) => `<section class="card inbox-group"><h2>${esc(g.name)}</h2>
      ${[...g.designs.values()].map(({ d, items }) => `<div class="inbox-design">
        <div class="row"><a href="#/d/${d.id}" style="font-weight:700">${esc(d.title)}</a><span class="muted small">${esc(d.months?.label || "")}</span>${badge(d.status)}</div>
        ${items.map((c) => `<div class="row small" style="align-items:flex-start;gap:8px"><span class="chip">${CATS[c.category]}</span><span style="flex:1;white-space:pre-wrap">${esc(c.body)}${c.version !== d.version ? ` <span class="muted">(من نسخة ${c.version})</span>` : ""}</span>
          <button class="btn sm" data-resolve="${c.id}">✓ اتنفذ</button></div>`).join("")}
      </div>`).join("")}</section>`).join("")}</div>`
      : `<div class="card empty"><b>مفيش تعديلات مفتوحة 🎉</b>كل اللي العملاء طلبوه اتنفذ.</div>`}
  </main>`;
  $$("[data-resolve]").forEach((b) => b.onclick = async () => { try { await api.resolveComment(b.dataset.resolve, true); toast("اتعلّم عليه اتنفذ"); route(); } catch (e) { fail(e); } });
}

route();
})();
