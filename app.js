"use strict";
/*
 * Comment Draw (Facebook login version)
 * - Read-only Graph API access, Page token kept in memory only.
 * - All Facebook text is inserted with textContent (never innerHTML).
 */
(function () {
  const GRAPH = "v23.0";
  // Your app's public IDs (not secrets). Change them in the page with "Change App ID".
  const DEFAULT_APP_ID = "1018220020650678";
  const DEFAULT_CONFIG_ID = "1488714263181596";
  const SCOPES = "pages_show_list,pages_read_engagement,pages_read_user_content";
  const $ = (id) => document.getElementById(id);

  const state = { userToken: null, pages: [], page: null, target: null, last: null };

  /* ---------- small helpers ---------- */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "className" || k === "textContent" || k === "type" || k === "disabled") e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  function safeHttps(url) {
    try { const u = new URL(url); return u.protocol === "https:" ? u.href : null; } catch { return null; }
  }
  function show(el, msg, kind) { el.hidden = !msg; el.textContent = msg || ""; el.className = "status" + (kind ? " " + kind : ""); }
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const list = (s) => s.split(/[,\n]/).map(norm).filter(Boolean);
  function randInt(max) {
    const lim = Math.floor(0x100000000 / max) * max, a = new Uint32Array(1);
    do { crypto.getRandomValues(a); } while (a[0] >= lim);
    return a[0] % max;
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  async function sha256(text) {
    if (!crypto.subtle) return "unavailable";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16).toUpperCase();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- storage (App ID only, never tokens) ---------- */
  const store = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };

  /* ---------- Graph API ---------- */
  async function graph(pathOrUrl, token, params) {
    let url;
    if (/^https:\/\/graph\.facebook\.com\//.test(pathOrUrl)) url = new URL(pathOrUrl);
    else {
      url = new URL(`https://graph.facebook.com/${GRAPH}/${pathOrUrl.replace(/^\//, "")}`);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    }
    url.searchParams.delete("access_token"); // token goes in the header only
    const res = await fetch(url.href, { headers: { Authorization: "Bearer " + token }, referrerPolicy: "no-referrer", credentials: "omit", cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const e = new Error((data.error && data.error.message) || `Facebook returned an error (${res.status}).`);
      e.code = data.error && data.error.code;
      throw e;
    }
    return data;
  }
  async function graphAll(path, token, params, onPage, max = 20000) {
    const out = [];
    let data = await graph(path, token, params);
    for (;;) {
      out.push(...(data.data || []));
      if (onPage) onPage(out.length);
      const next = data.paging && data.paging.next;
      if (!next || out.length >= max) break;
      data = await graph(next, token);
    }
    return out;
  }
  function friendly(err) {
    const m = String(err && err.message || err);
    if (err && err.code === 190) return "Your Facebook session expired. Press \"Log out\", then connect again.";
    if (err && (err.code === 10 || err.code === 200)) return "Facebook didn't give permission to read these comments. Connect again and allow every Page permission. (" + m + ")";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Couldn't reach Facebook. Check your internet connection and try again.";
    return m;
  }

  /* ---------- Facebook SDK ---------- */
  function loadSdk(appId) {
    return new Promise((resolve, reject) => {
      if (window.FB) { resolve(); return; }
      window.fbAsyncInit = function () {
        FB.init({ appId, version: GRAPH, cookie: false, xfbml: false, status: false });
        resolve();
      };
      const s = document.createElement("script");
      s.src = "https://connect.facebook.net/en_US/sdk.js";
      s.async = true; s.crossOrigin = "anonymous";
      s.onerror = () => reject(new Error("Couldn't load Facebook login. Check your internet connection or disable blockers for this page."));
      document.head.append(s);
    });
  }

  function checkOrigin() {
    if (location.protocol !== "https:") {
      show($("loginStatus"), "Open this page with start.bat (it must run at https://localhost:8000). Facebook login only works over HTTPS.", "err");
      $("loginBtn").disabled = true;
      return false;
    }
    return true;
  }

  async function init() {
    if (!store.get("cd.app")) { store.set("cd.app", DEFAULT_APP_ID); store.set("cd.config", DEFAULT_CONFIG_ID); }
    const appId = store.get("cd.app");
    $("appId").value = appId; $("configId").value = store.get("cd.config");
    if (!appId) { $("setupCard").hidden = false; $("loginCard").classList.add("locked"); return; }
    if (!checkOrigin()) return;
    try { await loadSdk(appId); } catch (e) { show($("loginStatus"), friendly(e), "err"); }
  }

  $("saveApp").onclick = () => {
    const id = $("appId").value.trim(), cfg = $("configId").value.trim();
    if (!/^\d{5,20}$/.test(id)) { alertField($("appId"), "The App ID is a number, found in your app's dashboard at developers.facebook.com."); return; }
    if (cfg && !/^\d{5,20}$/.test(cfg)) { alertField($("configId"), "The configuration ID is a number. Leave it empty if you don't have one."); return; }
    store.set("cd.app", id); store.set("cd.config", cfg);
    location.reload();
  };
  function alertField(el, msg) { el.focus(); el.setCustomValidity(msg); el.reportValidity(); el.addEventListener("input", () => el.setCustomValidity(""), { once: true }); }
  $("changeApp").onclick = () => { $("setupCard").hidden = false; $("appId").focus(); };

  $("loginBtn").onclick = () => login(false);
  $("morePagesBtn").onclick = () => login(true);

  function login(choosePages) {
    if (!window.FB) { show($("loginStatus"), "Facebook login is still loading. Try again in a moment.", "err"); return; }
    const cfg = store.get("cd.config");
    const opts = cfg ? { config_id: cfg } : { scope: SCOPES, return_scopes: true, auth_type: "rerequest" };
    if (choosePages) opts.auth_type = "reauthorize";
    if (choosePages) show($("loginStatus"), "In the Facebook window, choose \"Edit access\" (or \"Edit settings\") and tick every Page you want, then continue.");
    FB.login((resp) => {
      if (resp && resp.authResponse) { state.userToken = resp.authResponse.accessToken; loadPages(); }
      else show($("loginStatus"), "Login was cancelled.", "err");
    }, opts);
  }

  $("logoutBtn").onclick = () => {
    const done = () => {
      state.userToken = null; state.pages = []; state.page = null; state.target = null; state.last = null;
      $("pageSel").replaceChildren(); $("posts").replaceChildren(); $("posts").hidden = true;
      $("loggedIn").hidden = true; $("loggedOut").hidden = false;
      $("postCard").classList.add("locked"); $("drawCard").classList.add("locked");
      show($("loginStatus"), "Logged out. Nothing from your account is kept on this page.", "ok");
      show($("postStatus"), ""); show($("drawStatus"), "");
    };
    try { FB.getLoginStatus((r) => { if (r.status === "connected") FB.logout(done); else done(); }); } catch { done(); }
  };

  async function loadPages() {
    show($("loginStatus"), "Loading your Pages…");
    try {
      const pages = await graphAll("me/accounts", state.userToken, { fields: "id,name,access_token,picture{url}", limit: 100 });
      if (!pages.length) { show($("loginStatus"), "No Pages found. Log in with an account that manages the Page, and tick the Page when Facebook asks.", "err"); return; }
      state.pages = pages;
      const sel = $("pageSel"); sel.replaceChildren();
      pages.forEach((p, i) => sel.append(h("option", { value: String(i), textContent: p.name })));
      selectPage(0);
      $("loggedOut").hidden = true; $("loggedIn").hidden = false;
      $("postCard").classList.remove("locked");
      show($("loginStatus"), `Connected to ${pages.length} Page${pages.length > 1 ? "s" : ""}. Read-only access.`, "ok");
    } catch (e) { show($("loginStatus"), friendly(e), "err"); }
  }
  function selectPage(i) {
    state.page = state.pages[i]; state.target = null;
    $("drawCard").classList.add("locked"); $("posts").hidden = true; show($("postStatus"), "");
  }
  $("pageSel").onchange = (e) => selectPage(+e.target.value);

  /* ---------- finding the post ---------- */
  function idsFromLink(raw) {
    let u; try { u = new URL(raw.trim()); } catch { return null; }
    if (!/(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)fb\.com$/.test(u.hostname)) return null;
    const p = u.searchParams, path = u.pathname, ids = [];
    if (p.get("story_fbid") && p.get("id")) ids.push(`${p.get("id")}_${p.get("story_fbid")}`);
    ["fbid", "v", "story_fbid"].forEach((k) => { if (/^\d+$/.test(p.get(k) || "")) ids.push(p.get(k)); });
    const m = path.match(/\/(?:posts|videos|reel|reels|permalink|photos(?:\/[^/]+)?)\/(\d{6,})/);
    if (m) ids.push(m[1]);
    const pf = path.match(/(pfbid[A-Za-z0-9]+)/) || (p.get("story_fbid") || "").match(/(pfbid[A-Za-z0-9]+)/);
    return { ids: [...new Set(ids)], pfbid: pf ? pf[1] : null, share: /^\/share\//.test(path), href: u.href };
  }

  async function recentContent() {
    const tok = state.page.access_token, pid = state.page.id;
    const jobs = [
      graph(`${pid}/posts`, tok, { fields: "id,message,created_time,permalink_url,full_picture", limit: 50 }).then((d) => d.data || []).catch(() => []),
      graph(`${pid}/videos`, tok, { fields: "id,description,created_time,permalink_url,picture", limit: 50 }).then((d) => (d.data || []).map((v) => ({ id: v.id, message: v.description, created_time: v.created_time, permalink_url: v.permalink_url, full_picture: v.picture, video: true }))).catch(() => []),
    ];
    const [posts, videos] = await Promise.all(jobs);
    return posts.concat(videos).sort((a, b) => String(b.created_time).localeCompare(String(a.created_time)));
  }

  async function tryObject(id) {
    try { const d = await graph(id, state.page.access_token, { fields: "id" }); return d.id || id; } catch { return null; }
  }

  $("findBtn").onclick = async () => {
    const info = idsFromLink($("postLink").value);
    if (!info) { show($("postStatus"), "That doesn't look like a Facebook link. Copy the link of the post from your Page and paste it here.", "err"); return; }
    show($("postStatus"), "Looking for the post…");
    const pid = state.page.id;
    for (const id of info.ids) {
      const cands = id.includes("_") ? [id] : [`${pid}_${id}`, id];
      for (const c of cands) { const ok = await tryObject(c); if (ok) { setTarget({ id: ok, label: "Post found" }); return; } }
    }
    const recent = await recentContent();
    const hit = recent.find((r) => r.permalink_url && (
      (info.pfbid && r.permalink_url.includes(info.pfbid)) ||
      info.ids.some((id) => r.permalink_url.includes(id) || r.id.endsWith("_" + id) || r.id === id)));
    if (hit) { setTarget({ id: hit.id, label: "Post found" }); return; }
    renderPosts(recent);
    show($("postStatus"), info.share
      ? "Facebook's API can't read short share links. Pick the post from the list above."
      : "That post wasn't found on the selected Page. Check the Page, or pick the post from the list above.", "err");
  };
  $("browseBtn").onclick = async () => {
    show($("postStatus"), "Loading recent posts…");
    try { renderPosts(await recentContent()); show($("postStatus"), ""); } catch (e) { show($("postStatus"), friendly(e), "err"); }
  };

  function renderPosts(items) {
    const box = $("posts"); box.replaceChildren(); box.hidden = false;
    if (!items.length) { box.append(h("p", { className: "hint", textContent: "No recent posts found on this Page." })); return; }
    items.forEach((it) => {
      const img = safeHttps(it.full_picture);
      const date = it.created_time ? new Date(it.created_time).toLocaleDateString() : "";
      const btn = h("button", { type: "button", className: "post", onclick: () => {
          box.querySelectorAll(".post").forEach((b) => b.classList.remove("sel")); btn.classList.add("sel");
          setTarget({ id: it.id, label: "Post selected" });
        } },
        img ? h("img", { src: img, alt: "", referrerpolicy: "no-referrer" }) : h("div", { className: "noimg" }),
        h("div", null, h("b", { textContent: (it.message || (it.video ? "Video" : "Post without text")).slice(0, 120) }), h("span", { textContent: (it.video ? "Video · " : "") + date })));
      box.append(btn);
    });
  }

  function setTarget(t) {
    state.target = t;
    show($("postStatus"), `${t.label}. Set the rules, then pick the winner.`, "ok");
    $("drawCard").classList.remove("locked");
  }

  /* ---------- the draw ---------- */
  let drawing = false;
  $("drawBtn").onclick = async () => {
    if (drawing || !state.target) return;
    drawing = true; $("drawBtn").disabled = true;
    try {
      show($("drawStatus"), "Collecting comments… 0");
      const filter = $("replies").checked ? "stream" : "toplevel";
      const comments = await graphAll(`${state.target.id}/comments`, state.page.access_token,
        { fields: "id,message,created_time,permalink_url,from{id,name,picture.type(large){url}}", filter, limit: 100, order: "chronological" },
        (n) => show($("drawStatus"), `Collecting comments… ${n}`));

      const kws = list($("kw").value), ex = new Set(list($("excl").value));
      const seen = new Set(); const pool = [];
      let noName = 0;
      for (const c of comments) {
        const from = c.from || null;
        if (!from) noName++;
        if ($("noPage").checked && from && from.id === state.page.id) continue;
        if (from && ex.has(norm(from.name))) continue;
        if (kws.length && !kws.some((k) => norm(c.message).includes(k))) continue;
        const key = from ? "u:" + from.id : "c:" + c.id;
        if ($("unique").checked) { if (seen.has(key)) continue; seen.add(key); }
        pool.push(c);
      }
      if (!pool.length) { show($("drawStatus"), comments.length ? `Found ${comments.length} comments, but none match your rules.` : "This post has no comments yet.", "err"); return; }

      const nWin = Math.min(Math.max(1, parseInt($("nWin").value, 10) || 1), pool.length);
      const nBack = Math.min(Math.max(0, parseInt($("nBack").value, 10) || 0), pool.length - nWin);
      const picked = shuffle(pool).slice(0, nWin + nBack);
      state.last = {
        winners: picked.slice(0, nWin), backups: picked.slice(nWin), pool, total: comments.length, at: new Date(),
        seal: await sha256(pool.map((c) => c.id).sort().join(",")), hiddenNames: noName,
      };
      show($("drawStatus"), `Drawn from ${pool.length} eligible entries (${comments.length} comments).`, "ok");
      await reveal();
    } catch (e) {
      show($("drawStatus"), friendly(e), "err");
    } finally { drawing = false; $("drawBtn").disabled = false; }
  };

  function nameOf(c) { return c.from ? c.from.name : "Facebook user"; }
  function avatar(c) {
    const url = c.from && c.from.picture && c.from.picture.data && safeHttps(c.from.picture.data.url);
    if (url) return h("img", { className: "avatar", src: url, alt: "", referrerpolicy: "no-referrer" });
    return h("div", { className: "avatar", textContent: (nameOf(c)[0] || "?").toUpperCase() });
  }

  async function reveal() {
    const d = state.last, rv = $("rv"), box = $("reveal");
    box.hidden = false; document.body.style.overflow = "hidden";
    if (!reduce) {
      for (const n of [3, 2, 1]) {
        rv.replaceChildren(h("div", { className: "eyebrow", textContent: `${d.pool.length} entries · drawing` }), h("div", { className: "count", textContent: String(n) }));
        await sleep(900);
      }
    }
    renderWinner();
    confetti();
  }

  function renderWinner() {
    const d = state.last, rv = $("rv"), w = d.winners[0];
    const link = safeHttps(w.permalink_url);
    const kids = [
      h("div", { className: "eyebrow", textContent: d.winners.length > 1 ? `Winner 1 of ${d.winners.length}` : "And the winner is" }),
      avatar(w),
      h("div", { className: "wname", textContent: nameOf(w) }),
      w.message ? h("div", { className: "wtext", textContent: "“" + w.message.slice(0, 280) + "”" }) : null,
      h("div", { className: "row" },
        link ? h("a", { className: "btn primary", href: link, target: "_blank", rel: "noopener noreferrer", textContent: "Open winning comment" }) : null,
        h("button", { type: "button", textContent: "Redraw", title: "Use this if the winner isn't eligible", onclick: () => redraw() }),
        h("button", { type: "button", textContent: "Copy announcement", onclick: (e) => copy(announcement(), e.target) }),
        h("button", { type: "button", textContent: "Close", onclick: closeReveal })),
    ];
    if (d.winners.length > 1) kids.push(h("div", { className: "backups", textContent: "Other winners: " + d.winners.slice(1).map(nameOf).join(", ") }));
    if (d.backups.length) kids.push(h("div", { className: "backups", textContent: "Backup: " + d.backups.map(nameOf).join(", ") }));
    if (d.hiddenNames) kids.push(h("div", { className: "backups", textContent: `Facebook hid the name on ${d.hiddenNames} comments. Open the winning comment to see who it is.` }));
    kids.push(h("div", { className: "record", textContent:
      `Draw record\nDate: ${d.at.toLocaleString()}\nComments collected: ${d.total}\nEligible entries: ${d.pool.length}\nEntry list seal (SHA-256): ${d.seal}\nMethod: crypto.getRandomValues + Fisher–Yates shuffle` }));
    rv.replaceChildren(...kids.filter(Boolean));
  }

  function redraw() {
    const d = state.last;
    const taken = new Set(d.winners.concat(d.backups).map((c) => (c.from ? "u:" + c.from.id : "c:" + c.id)));
    const left = d.pool.filter((c) => !taken.has(c.from ? "u:" + c.from.id : "c:" + c.id));
    if (left.length) d.winners[0] = left[randInt(left.length)];
    else if (d.backups.length) d.winners[0] = d.backups.shift();
    else return;
    renderWinner(); confetti();
  }

  function announcement() {
    const d = state.last, ws = d.winners.map(nameOf);
    let s = ws.length > 1 ? "🎉 Congratulations to our winners!\n" + ws.map((n, i) => `${i + 1}. ${n}`).join("\n") : `🎉 Congratulations ${ws[0]}, you won our giveaway!`;
    if (d.backups.length) s += "\n\nBackup: " + d.backups.map(nameOf).join(", ");
    return s + `\n\nDrawn at random from ${d.pool.length} entries. Please send us a message to claim your prize.`;
  }
  async function copy(text, btn) {
    const label = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
    catch { btn.textContent = "Copy failed"; }
    setTimeout(() => { btn.textContent = label; }, 1800);
  }
  function closeReveal() { $("reveal").hidden = true; document.body.style.overflow = ""; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("reveal").hidden) closeReveal(); });

  function confetti() {
    if (reduce) return;
    const c = $("confetti"), ctx = c.getContext("2d"), dpr = devicePixelRatio || 1;
    const W = (c.width = innerWidth * dpr), H = (c.height = innerHeight * dpr);
    const cols = ["#f5c12e", "#ffffff", "#8fb0ff", "#ff7aa2", "#5fd09a"];
    const ps = Array.from({ length: 220 }, () => ({ x: W / 2, y: H * 0.45, vx: (Math.random() - 0.5) * 22 * dpr, vy: (-Math.random() * 18 - 5) * dpr, s: (5 + Math.random() * 6) * dpr, r: Math.random() * 6, c: cols[(Math.random() * cols.length) | 0] }));
    let f = 0;
    (function tick() {
      ctx.clearRect(0, 0, W, H);
      for (const p of ps) { p.x += p.vx; p.y += p.vy; p.vy += 0.4 * dpr; p.vx *= 0.99; p.r += 0.15; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); }
      if (++f < 180) requestAnimationFrame(tick); else ctx.clearRect(0, 0, W, H);
    })();
  }

  init();
})();
