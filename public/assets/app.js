// DarujKnihu.sk – statický web (GitHub Pages) napojený na Firebase (bezplatný plán Spark).
// Bez Cloud Functions: každý krok výmeny je dávka zápisov a firestore.rules ju pustia,
// len keď sedí celá (objednávka, ponuka aj body naraz).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, limit, onSnapshot, serverTimestamp, writeBatch, increment,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig, useEmulators } from "./firebase-config.js";
import { DICT } from "./i18n.js";
import { GENRES, CONDITIONS, LANGUAGES, SEND_DEADLINE_DAYS } from "./constants.js";

const COVER_COLORS = ["#2F4858", "#7A3B2E", "#3D5A3C", "#5B4B8A", "#8A6A1F", "#1F5C6B", "#6B2F4A", "#44403C", "#3B4F7A", "#6A4E2E"];

/* ---------- Firebase ---------- */

const configured = useEmulators || !String(firebaseConfig.apiKey).startsWith("DOPLNIT");
// Emulátory bežia pod offline projektom demo-darujknihu (firebase emulators:start --project demo-darujknihu).
const app = initializeApp(useEmulators
  ? { ...firebaseConfig, apiKey: "demo-key", projectId: "demo-darujknihu" }
  : firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
if (useEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
const ref = (...path) => doc(db, ...path);
const newId = (col) => doc(collection(db, col)).id;

/* ---------- stav a pomocné ---------- */

const S = { user: null, profile: null, todo: 0, ready: false };
let routeSubs = [];
let userSubs = [];
const catalogFilter = { q: "", genre: "", lang: "" };
const orderCache = new Map();

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const ms = (ts) => (ts?.toMillis ? ts.toMillis() : 0);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

function lang() {
  const pick = store.get("dk-lang");
  if (pick === "sk" || pick === "cs") return pick;
  if (S.profile?.country === "CZ") return "cs";
  return navigator.language?.startsWith("cs") ? "cs" : "sk";
}
const T = () => DICT[lang()];
const genreLabel = (g) => T().genres[g] || g;
const condLabel = (c) => T().conditions[c] || c;
const fmtDate = (d) => d.toLocaleDateString(T().locale);

function toast(text, err = false) {
  const t = document.createElement("div");
  t.className = `toast${err ? " err" : ""}`;
  t.textContent = text;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 5000);
}
const errText = (e) => T().auth.errors[e?.code] || (e?.shown ? e.message : T().common.error);
const fail = (msg) => { throw Object.assign(new Error(msg), { shown: true }); };
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

function cover(l, size = "") {
  return `<div class="cover ${size}" style="background:${esc(l.color)}" aria-hidden="true">
    <div><div class="t">${esc(l.title)}</div><div class="rule"></div></div><div class="a">${esc(l.author)}</div></div>`;
}

function busy(form, on) {
  form.querySelectorAll("button, input, select, textarea").forEach((el) => (el.disabled = on));
}

/* ---------- hlavička ---------- */

function renderHeader() {
  const t = T();
  const path = location.hash.replace(/^#/, "") || "/";
  const tabs = [["/", t.nav.catalog], ["/darovat", t.nav.donate], ["/wishlist", t.nav.wishlist], ["/vymeny", t.nav.exchanges]];
  $("#nav").innerHTML = tabs.map(([h, label]) => {
    const active = h === "/" ? path === "/" || path.startsWith("/kniha") : path.startsWith(h);
    const dot = h === "/vymeny" && S.todo ? `<span class="dot">${S.todo}</span>` : "";
    return `<a class="tab" href="#${h}" ${active ? 'aria-current="page"' : ""}>${label}${dot}</a>`;
  }).join("");
  const l = lang();
  const langs = `<span class="langs" role="group" aria-label="Jazyk"><button data-lang="sk" aria-pressed="${l === "sk"}">SK</button><button data-lang="cs" aria-pressed="${l === "cs"}">CZ</button></span>`;
  if (S.user && S.profile) {
    const p = S.profile.points || 0;
    $("#wallet").innerHTML = `${langs}
      <a class="pill points" href="#/vymeny"><b>${p}</b> ${t.pts(p).replace(/^\d+ /, "")}</a>
      <a class="btn small ghost" href="#/profil">${t.header.profile}</a>
      <button class="btn small ghost" data-action="logout">${t.header.logout}</button>`;
  } else if (S.user) {
    $("#wallet").innerHTML = `${langs}<button class="btn small ghost" data-action="logout">${t.header.logout}</button>`;
  } else {
    $("#wallet").innerHTML = `${langs}<a class="btn small ghost" href="#/prihlasenie">${t.header.login}</a><a class="btn small primary" href="#/registracia">${t.header.register}</a>`;
  }
  document.documentElement.lang = l;
  const banner = !configured ? t.common.configMissing : useEmulators ? "Lokálne testovanie (Firebase emulátory)" : "";
  $("#banner").hidden = !banner;
  $("#banner-text").textContent = banner;
}

/* ---------- smerovanie ---------- */

function route() {
  routeSubs.forEach((u) => u());
  routeSubs = [];
  renderHeader();
  if (!S.ready) return;
  const path = location.hash.replace(/^#/, "") || "/";
  const [, seg, id] = path.split("/");
  const needAuth = ["darovat", "wishlist", "vymeny", "profil"];
  if (needAuth.includes(seg) && !S.user) return go("#/prihlasenie");
  if (S.user && !S.profile && seg !== "profil") return go("#/profil");
  const view = {
    "": viewCatalog, kniha: () => viewBook(id), darovat: viewDonate, wishlist: viewWishlist, vymeny: viewExchanges,
    prihlasenie: viewLogin, registracia: viewRegister, heslo: viewReset, profil: viewProfile,
  }[seg || ""] || viewCatalog;
  view();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

onAuthStateChanged(auth, (user) => {
  routeSubs.forEach((u) => u());
  routeSubs = [];
  userSubs.forEach((u) => u());
  userSubs = [];
  S.user = user;
  S.profile = null;
  S.todo = 0;
  if (!user) {
    S.ready = true;
    return route();
  }
  // Kým sa nenačíta profil, nič nesmerujeme (inak by prihlásený skončil na stránke Profil).
  S.ready = false;
  $("#view").innerHTML = `<p class="center">${T().common.loading}</p>`;
  let first = true;
  userSubs.push(onSnapshot(doc(db, "users", user.uid), (snap) => {
    const hadProfile = !!S.profile;
    S.profile = snap.exists() ? snap.data() : null;
    renderHeader();
    if (first || hadProfile !== !!S.profile) { first = false; S.ready = true; route(); }
  }));
  // Počet vecí, ktoré čakajú na používateľa: odoslať knihu, potvrdiť vyzdvihnutie, rozhodnúť o knihe.
  const todo = { out: 0, in: 0 };
  const setTodo = () => { S.todo = todo.out + todo.in; renderHeader(); };
  userSubs.push(onSnapshot(query(collection(db, "orders"), where("donorUid", "==", user.uid)), (s) => {
    todo.out = s.docs.filter((d) => d.data().status === "CREATED").length;
    setTodo();
  }, () => {}));
  userSubs.push(onSnapshot(query(collection(db, "orders"), where("recipientUid", "==", user.uid)), (s) => {
    todo.in = s.docs.filter((d) => { const o = d.data(); return o.status === "SENT" || (o.status === "PICKED_UP" && !o.keep); }).length;
    setTodo();
  }, () => {}));
});

/* ---------- katalóg ---------- */

function viewCatalog() {
  const t = T().home;
  $("#view").innerHTML = `
    <section class="intro">
      <div><h1>${t.title1}<em>${t.title2}</em>${t.title3}</h1><p class="sub">${t.sub}</p></div>
      <ol class="steps">
        <li><span class="n">1</span><div><b>${t.s1}</b><span>${t.s1d}</span></div></li>
        <li><span class="n">2</span><div><b>${t.s2}</b><span>${t.s2d}</span></div></li>
        <li><span class="n">3</span><div><b>${t.s3}</b><span>${t.s3d}</span></div></li>
      </ol>
    </section>
    <div class="section-head"><div><h2>${t.catalog}</h2><p class="sub" id="count">${T().common.loading}</p></div></div>
    <div class="filters"><input class="field" type="search" id="q" placeholder="${esc(t.search)}" aria-label="${esc(t.search)}" value="${esc(catalogFilter.q)}"></div>
    <div class="chips" id="lang-chips" style="margin-bottom:8px"></div>
    <div class="chips" id="genre-chips" style="margin-bottom:20px"></div>
    <div id="grid"></div>`;
  let listings = [];
  let wishes = [];
  const draw = () => {
    const tt = T();
    $("#lang-chips").innerHTML = [["", t.allLangs], ...LANGUAGES.map((l) => [l, tt.languages[l]])]
      .map(([v, label]) => `<button class="chip" data-filter="lang" data-value="${v}" aria-current="${catalogFilter.lang === v}">${esc(label)}</button>`).join("");
    $("#genre-chips").innerHTML = [["", t.allGenres], ...GENRES.map((g) => [g, genreLabel(g)])]
      .map(([v, label]) => `<button class="chip" data-filter="genre" data-value="${esc(v)}" aria-current="${catalogFilter.genre === v}">${esc(label)}</button>`).join("");
    const q = norm(catalogFilter.q);
    const wq = wishes.map((w) => w.qn).filter(Boolean);
    const uid = S.user?.uid;
    const items = listings
      .filter((l) => (!catalogFilter.genre || l.genre === catalogFilter.genre) && (!catalogFilter.lang || l.language === catalogFilter.lang))
      .filter((l) => !q || l.search.includes(q))
      .map((l) => ({ l, onWish: l.donorUid !== uid && wq.some((w) => l.search.includes(w)), reserved: uid && l.reservedFor === uid && ms(l.reservedUntil) > Date.now() }))
      .sort((a, b) => Number(b.reserved || b.onWish) - Number(a.reserved || a.onWish) || ms(b.l.createdAt) - ms(a.l.createdAt));
    $("#count").textContent = t.count(listings.length);
    $("#grid").innerHTML = items.length
      ? `<div class="grid">${items.map(({ l, onWish, reserved }) => `
          <a class="card ${onWish || reserved ? "match" : ""}" href="#/kniha/${l.id}">
            ${cover(l)}
            <div class="meta">
              <span class="title">${esc(l.title)}</span><span class="author">${esc(l.author)}</span>
              <div class="row">
                ${reserved ? `<span class="tag hot">${t.reservedForYou}</span>` : onWish ? `<span class="tag hot">${t.fromWish}</span>` : ""}
                ${l.donorUid === uid ? `<span class="tag good">${t.yours}</span>` : ""}
                <span class="tag">${esc(condLabel(l.condition))}</span>
                ${l.language !== lang() ? `<span class="tag">${esc(tt.languages[l.language] || l.language)}</span>` : ""}
              </div>
              <span class="donor">${esc(l.donorName)}, ${esc(l.donorCity)} · ${esc(l.donorCountry)}</span>
            </div></a>`).join("")}</div>`
      : `<div class="empty">${t.empty}</div>`;
  };
  if (!configured) { $("#count").textContent = ""; draw(); return; }
  routeSubs.push(onSnapshot(query(collection(db, "listings"), where("status", "==", "AVAILABLE"), limit(500)), (s) => {
    listings = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => toast(T().common.error, true)));
  if (S.user) {
    routeSubs.push(onSnapshot(query(collection(db, "wishlist"), where("uid", "==", S.user.uid)), (s) => {
      wishes = s.docs.map((d) => d.data());
      draw();
    }));
  }
  draw();
  $("#q").addEventListener("input", (e) => { catalogFilter.q = e.target.value; draw(); });
}

/* ---------- detail knihy ---------- */

function viewBook(id) {
  const tb = T().book;
  $("#view").innerHTML = `<p class="center">${T().common.loading}</p>`;
  let l = null;
  let passport = [];
  let donor = null;
  const draw = () => {
    const tt = T();
    if (!l) { $("#view").innerHTML = `<p class="center"><a href="#/">${tt.common.back}</a></p>`; return; }
    const uid = S.user?.uid;
    const resLeft = Math.max(0, Math.ceil((ms(l.reservedUntil) - Date.now()) / 3600e3));
    const reservedOther = l.reservedFor && l.reservedFor !== uid && resLeft > 0;
    const reservedMe = uid && l.reservedFor === uid && resLeft > 0;
    const points = S.profile?.points || 0;
    const saved = JSON.parse(store.get("dk-ship") || "{}");
    const stats = donor
      ? donor.ratingCount ? tb.rating((donor.ratingSum / donor.ratingCount).toFixed(1), donor.sentCount || 0) : tb.sentOnly(donor.sentCount || 0)
      : "";
    const pickupUrl = S.profile?.country === "CZ" ? "https://www.zasilkovna.cz" : "https://www.packeta.sk";
    let claim;
    if (l.status !== "AVAILABLE") claim = `<div class="claim"><b>${tb.gone}</b></div>`;
    else if (l.donorUid === uid) claim = `<div class="claim"><span>${tb.mine}</span></div>`;
    else if (!S.user) claim = `<div class="claim"><span>${tb.loginToClaim}</span><div class="row"><a class="btn primary" href="#/prihlasenie">${tt.header.login}</a><a class="btn" href="#/registracia">${tt.header.register}</a></div></div>`;
    else if (reservedOther) claim = `<div class="claim"><b>${tb.reservedOther(resLeft)}</b></div>`;
    else if (points < 1) claim = `<div class="claim"><div class="warnbox">${tb.noPoints}</div><div class="row"><a class="btn primary" href="#/darovat">${tt.nav.donate}</a></div></div>`;
    else claim = `
      <form class="claim" data-form="claim">
        <b>${tb.claimTitle}</b>
        <div><label class="l" for="c-name">${tb.fullName}</label><input class="field w" id="c-name" name="fullName" required minlength="3" maxlength="80" autocomplete="name" value="${esc(saved.fullName || "")}"></div>
        <div><label class="l" for="c-phone">${tb.phone}</label><input class="field w" id="c-phone" name="phone" type="tel" required minlength="9" maxlength="20" autocomplete="tel" value="${esc(saved.phone || "")}"></div>
        <div><label class="l" for="c-point">${tb.pickup}</label><input class="field w" id="c-point" name="pickupPoint" required minlength="3" maxlength="200" value="${esc(saved.pickupPoint || "")}">
          <p class="hint" style="margin:6px 0 0">${tb.pickupHint} <a href="${pickupUrl}" target="_blank" rel="noopener">${tb.pickupLink}</a>.</p></div>
        <p class="note" style="margin:0">${tb.privacy} ${tb.cost}</p>
        <div class="row"><button class="btn primary">${tb.claim}</button><span class="note">${tb.deadline(SEND_DEADLINE_DAYS)}</span></div>
      </form>`;
    const n = passport.length;
    const tp = tt.passport;
    $("#view").innerHTML = `
      <div class="stack" style="gap:24px">
        <a href="#/" class="hint">${tt.common.back}</a>
        <div class="detail">
          ${cover(l, "big")}
          <div class="info">
            <div><h1>${esc(l.title)}</h1><p class="sub">${esc(l.author)}</p></div>
            <div class="row">
              <span class="tag">${esc(genreLabel(l.genre))}</span>
              <span class="tag good">${esc(condLabel(l.condition))}</span>
              <span class="tag">${esc(tt.languages[l.language] || l.language)}</span>
              ${reservedMe ? `<span class="tag hot">${tb.reservedMe(resLeft)}</span>` : ""}
            </div>
            ${l.note ? `<p style="margin:0">„${esc(l.note)}“</p>` : ""}
            ${l.photo ? `<a href="${esc(l.photo)}" target="_blank" rel="noopener"><img class="photo-prev" src="${esc(l.photo)}" alt=""></a>` : ""}
            <p class="donor" style="margin:0">${esc(tb.donor(l.donorName, l.donorCity, tt.countries[l.donorCountry] || l.donorCountry))}${esc(stats)}</p>
            ${claim}
          </div>
        </div>
        <div class="passport">
          <header><b>${tp.title}</b><span>${n ? tp.before(n) : tp.starts}</span></header>
          ${n ? passport.map((e) => `<div class="pp-row"><span class="pp-stamp">${fmtDate(e.createdAt.toDate())}</span>
              <div><p><b>${esc(e.name)}</b> <small>· ${esc(e.city)}</small></p>${e.note ? `<p>„${esc(e.note)}“</p>` : ""}</div></div>`).join("")
            : `<div class="pp-row"><span class="pp-stamp">${fmtDate(new Date())}</span><div><p>${tp.first}</p></div></div>`}
        </div>
      </div>`;
  };
  routeSubs.push(onSnapshot(doc(db, "listings", id), async (snap) => {
    l = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (l) {
      const ps = await getDocs(collection(db, "copies", l.copyId, "passport"));
      passport = ps.docs.map((d) => d.data()).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
      if (S.user && !donor) donor = (await getDoc(doc(db, "users", l.donorUid))).data() || null;
    }
    draw();
  }, () => toast(T().common.error, true)));
}

/* ---------- darovanie ---------- */

function viewDonate() {
  const t = T().donate;
  const tt = T();
  const defLang = S.profile.country === "CZ" ? "cs" : "sk";
  $("#view").innerHTML = `
    <div class="section-head"><div><h1>${t.title}</h1><p class="sub">${t.sub}</p></div></div>
    <div class="two">
      <form class="panel stack" data-form="donate" novalidate>
        <div><label class="l" for="isbn">${t.isbn}</label>
          <div class="isbn-row"><input class="field" id="isbn" name="isbn" inputmode="numeric" placeholder="978…" autocomplete="off">
          <button class="btn" type="button" data-action="isbn">${t.load}</button></div>
          <p class="hint" id="isbn-msg" role="status" style="margin:6px 0 0">${t.isbnHint}</p></div>
        <div><label class="l" for="title">${t.titleF}</label><input class="field w" id="title" name="title" required maxlength="200"></div>
        <div><label class="l" for="author">${t.author}</label><input class="field w" id="author" name="author" required maxlength="200"></div>
        <div><label class="l" for="genre">${t.genre}</label><select class="field w" id="genre" name="genre">${GENRES.map((g) => `<option value="${esc(g)}">${esc(genreLabel(g))}</option>`).join("")}</select></div>
        <div><label class="l" for="language">${t.language}</label><select class="field w" id="language" name="language">${LANGUAGES.map((l) => `<option value="${l}" ${l === defLang ? "selected" : ""}>${tt.languages[l]}</option>`).join("")}</select></div>
        <div><span class="l">${t.condition}</span><div class="radios">${CONDITIONS.map((c, i) => `<span><input type="radio" name="condition" id="cond-${i}" value="${esc(c)}" ${i === 1 ? "checked" : ""}><label for="cond-${i}">${esc(condLabel(c))}</label></span>`).join("")}</div></div>
        <div><label class="l" for="note">${t.note}</label><textarea class="field w" id="note" name="note" maxlength="300" placeholder="${esc(t.notePh)}"></textarea></div>
        <div><label class="l" for="photo">${t.photo}</label><input type="file" id="photo" name="photo" accept="image/jpeg,image/png,image/webp"></div>
        <div class="row"><button class="btn primary" id="donate-btn">${t.submit}</button></div>
      </form>
      <div class="stack"><h2 style="font-size:20px">${t.mine}</h2><div id="mine"><p class="hint">${tt.common.loading}</p></div></div>
    </div>`;
  routeSubs.push(onSnapshot(query(collection(db, "listings"), where("donorUid", "==", S.user.uid)), (s) => {
    const mine = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    $("#mine").innerHTML = mine.length ? `<div class="list">${mine.map((l) => `
      <div class="order">${cover(l, "mini")}<div class="stack" style="gap:6px;min-width:0">
        <h3><a href="#/kniha/${l.id}" style="color:inherit">${esc(l.title)}</a></h3>
        <span class="donor">${esc(l.author)} · ${esc(condLabel(l.condition))}</span>
        <div class="row"><span class="tag ${l.status === "DELIVERED" ? "good" : l.status === "CLAIMED" ? "hot" : ""}">${t.status[l.status] || l.status}</span>
        ${l.status === "AVAILABLE" ? `<button class="linkbtn note" data-action="withdraw" data-id="${l.id}">${t.withdraw}</button>` : ""}</div>
      </div></div>`).join("")}</div>` : `<div class="empty">${t.none}</div>`;
  }));
}

async function lookupIsbn(raw) {
  const isbn = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (isbn.length !== 10 && isbn.length !== 13) return null;
  try {
    const j = await (await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`)).json();
    const b = j[`ISBN:${isbn}`];
    if (b?.title) return { isbn, title: b.title, author: (b.authors || []).map((a) => a.name).join(", ") };
  } catch {}
  try {
    const j = await (await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`)).json();
    const v = j.items?.[0]?.volumeInfo;
    if (v?.title) return { isbn, title: v.title, author: (v.authors || []).join(", ") };
  } catch {}
  return null;
}

/* ---------- wishlist ---------- */

function viewWishlist() {
  const t = T().wishlist;
  $("#view").innerHTML = `
    <div class="section-head"><div><h1>${t.title}</h1><p class="sub">${t.sub}</p></div></div>
    <div class="panel stack" style="max-width:680px">
      <form class="isbn-row" data-form="wish"><input class="field" name="q" required maxlength="120" placeholder="${esc(t.ph)}" aria-label="${esc(t.ph)}" style="font-family:var(--f-body)"><button class="btn primary">${t.add}</button></form>
      <div id="wishes"><p class="hint">${T().common.loading}</p></div>
    </div>`;
  let wishes = [];
  let available = [];
  const draw = () => {
    $("#wishes").innerHTML = wishes.length ? `<div class="list">${wishes.map((w) => {
      const hits = available.filter((l) => l.donorUid !== S.user.uid && l.search.includes(w.qn));
      return `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:10px">
        <div style="min-width:0"><b>${esc(w.q)}</b><br>${hits.length ? hits.map((h) => `<div><a href="#/kniha/${h.id}" style="color:var(--stamp);font-size:14px">${t.available} ${esc(h.title)} (${esc(h.donorCity)})</a></div>`).join("") : `<span class="hint">${t.none}</span>`}</div>
        <button class="btn small ghost" data-action="unwish" data-id="${w.id}">${T().common.remove}</button></div>`;
    }).join("")}</div>` : `<div class="empty">${t.empty}</div>`;
  };
  routeSubs.push(onSnapshot(query(collection(db, "wishlist"), where("uid", "==", S.user.uid)), (s) => {
    wishes = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    draw();
  }));
  routeSubs.push(onSnapshot(query(collection(db, "listings"), where("status", "==", "AVAILABLE"), limit(500)), (s) => {
    available = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }));
}

/* ---------- výmeny ---------- */

function track(status) {
  const steps = ["CREATED", "SENT", "PICKED_UP"];
  const idx = steps.indexOf(status);
  return `<ol class="track" style="grid-template-columns:repeat(3,1fr)">${steps.map((s, i) =>
    `<li class="${i < idx || status === "PICKED_UP" ? "done" : i === idx ? "now" : ""}">${T().ex.steps[s]}</li>`).join("")}</ol>`;
}
const trackUrl = (n) => `https://tracking.packeta.com/${lang() === "cs" ? "cs" : "sk"}/?id=${encodeURIComponent(n)}`;

function viewExchanges() {
  const t = T().ex;
  $("#view").innerHTML = `
    <div class="section-head"><div><h1>${t.title}</h1><p class="sub">${t.have(T().pts(S.profile.points || 0))}</p></div></div>
    <div class="two">
      <section class="stack"><h2 style="font-size:20px">${t.incoming}</h2><div id="incoming"><p class="hint">${T().common.loading}</p></div></section>
      <section class="stack"><h2 style="font-size:20px">${t.outgoing}</h2><div id="outgoing"><p class="hint">${T().common.loading}</p></div></section>
    </div>`;
  const deadline = (o) => fmtDate(new Date(ms(o.createdAt) + SEND_DEADLINE_DAYS * 86400e3));
  const incoming = (o) => {
    let body = o.status === "CANCELLED" ? `<p class="warnbox" style="margin-top:10px">${t.cancelled}</p>` : track(o.status);
    if (o.status === "CREATED") {
      const late = Date.now() - ms(o.createdAt) > SEND_DEADLINE_DAYS * 86400e3;
      body += `<p class="note" style="margin:0">${t.waitSend(deadline(o))}</p>`;
      if (late) body += `<button class="btn small" data-action="cancel" data-id="${o.id}" style="margin-top:8px">${t.cancelLate}</button>`;
    }
    if (o.status === "SENT") {
      body += `<div class="stack" style="gap:8px"><span class="note">${esc(t.sentInfo(o.trackingNumber))} · <a href="${trackUrl(o.trackingNumber)}" target="_blank" rel="noopener">${t.track}</a></span>
        <div class="row"><button class="btn small primary" data-action="pickup" data-id="${o.id}">${t.confirm}</button></div></div>`;
    }
    if (o.status === "PICKED_UP") {
      body += `<div class="stack" style="gap:10px">`;
      body += o.rating ? `<span class="tag good" style="align-self:start">${t.rated(o.rating)}</span>`
        : `<div class="row"><span class="note">${t.rate}</span>${[1, 2, 3, 4, 5].map((n) => `<button class="btn small ghost" data-action="rate" data-id="${o.id}" data-value="${n}" aria-label="${n}/5">${"★".repeat(n)}</button>`).join("")}</div>`;
      body += o.keep === "PASS" ? `<span class="tag good" style="align-self:start">${t.passed}</span>`
        : `<span class="note">${o.keep === "KEEP" ? t.kept : t.keepAsk}</span><div class="row">${o.keep !== "KEEP" ? `<button class="btn small" data-action="keep" data-id="${o.id}" data-value="KEEP">${t.keep}</button>` : ""}<button class="btn small primary" data-action="keep" data-id="${o.id}" data-value="PASS">${t.pass}</button></div>`;
      body += `<form class="isbn-row" data-form="note" data-id="${o.id}"><input class="field" name="note" maxlength="200" placeholder="${esc(t.notePh)}" aria-label="${esc(t.note)}" style="font-family:var(--f-body)"><button class="btn small">${t.noteSave}</button></form>`;
      body += `</div>`;
    }
    return `<div class="order">${cover(o, "mini")}<div style="min-width:0"><h3>${esc(o.title)}</h3><span class="donor">${esc(t.from(o.donorName))}</span>${body}</div></div>`;
  };
  const outgoing = (o) => {
    let body = o.status === "CANCELLED" ? `<p class="warnbox" style="margin-top:10px">${t.cancelledOut}</p>` : track(o.status);
    if (o.status === "CREATED") {
      const s = o.shipTo || {};
      body += `<div class="stack" style="gap:8px">
        <span class="note">${t.sendHow}</span>
        <dl class="ship"><dt>${t.shipName}</dt><dd>${esc(s.fullName)}</dd><dt>${t.shipPhone}</dt><dd>${esc(s.phone)}</dd><dt>${t.shipEmail}</dt><dd>${esc(s.email)}</dd><dt>${t.shipPoint}</dt><dd>${esc(s.pickupPoint)}</dd></dl>
        <span class="note">${t.waitSend(deadline(o))}</span>
        <form class="isbn-row" data-form="sent" data-id="${o.id}"><input class="field" name="tracking" required minlength="4" maxlength="40" placeholder="${esc(t.tracking)}" aria-label="${esc(t.tracking)}"><button class="btn small primary">${t.markSent}</button></form>
        <button class="linkbtn note" style="align-self:start" data-action="cancel" data-id="${o.id}">${t.cancelOut}</button></div>`;
    }
    if (o.status === "SENT") body += `<span class="note">${esc(t.sentInfo(o.trackingNumber))} · <a href="${trackUrl(o.trackingNumber)}" target="_blank" rel="noopener">${t.track}</a></span>`;
    if (o.status === "PICKED_UP") body += `<span class="tag good">${esc(t.deliveredOut(o.recipientName))}</span>`;
    return `<div class="order">${cover(o, "mini")}<div style="min-width:0"><h3>${esc(o.title)}</h3><span class="donor">${esc(t.to(o.recipientName, o.recipientCity))}</span>${body}</div></div>`;
  };
  const sub = (field, el, render, empty) => routeSubs.push(onSnapshot(query(collection(db, "orders"), where(field, "==", S.user.uid)), (s) => {
    const list = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    list.forEach((o) => orderCache.set(o.id, o));
    $(el).innerHTML = list.length ? `<div class="list">${list.map(render).join("")}</div>` : `<div class="empty">${empty}</div>`;
  }, () => toast(T().common.error, true)));
  sub("recipientUid", "#incoming", incoming, t.noIncoming);
  sub("donorUid", "#outgoing", outgoing, t.noOutgoing);
}

/* ---------- účet ---------- */

function viewLogin() {
  const t = T().auth;
  $("#view").innerHTML = `<div class="narrow stack">
    <div class="section-head"><h1>${t.login}</h1></div>
    <form class="panel stack" data-form="login">
      <div><label class="l" for="email">${t.email}</label><input class="field w" id="email" name="email" type="email" autocomplete="email" required></div>
      <div><label class="l" for="password">${t.password}</label><input class="field w" id="password" name="password" type="password" autocomplete="current-password" required></div>
      <div class="row"><button class="btn primary">${t.submitLogin}</button><a class="hint" href="#/heslo">${t.forgot}</a></div>
    </form>
    <p class="hint">${t.noAccount}<a href="#/registracia">${T().header.register}</a></p></div>`;
}

function profileFields(p = {}) {
  const t = T().auth;
  const c = p.country || (lang() === "cs" ? "CZ" : "SK");
  return `
    <div><label class="l" for="name">${t.name}</label><input class="field w" id="name" name="name" required minlength="2" maxlength="60" autocomplete="given-name" value="${esc(p.name || "")}"></div>
    <div><span class="l">${t.country}</span><div class="radios">
      <span><input type="radio" name="country" id="c-sk" value="SK" ${c === "SK" ? "checked" : ""}><label for="c-sk">${T().countries.SK}</label></span>
      <span><input type="radio" name="country" id="c-cz" value="CZ" ${c === "CZ" ? "checked" : ""}><label for="c-cz">${T().countries.CZ}</label></span>
    </div><p class="hint" style="margin:6px 0 0">${t.countryHint}</p></div>
    <div><label class="l" for="city">${t.city}</label><input class="field w" id="city" name="city" required minlength="2" maxlength="60" autocomplete="address-level2" value="${esc(p.city || "")}"></div>`;
}

function viewRegister() {
  if (S.user) return go("#/");
  const t = T().auth;
  $("#view").innerHTML = `<div class="narrow stack">
    <div class="section-head"><h1>${t.register}</h1></div>
    <form class="panel stack" data-form="register">
      ${profileFields()}
      <div><label class="l" for="email">${t.email}</label><input class="field w" id="email" name="email" type="email" autocomplete="email" required></div>
      <div><label class="l" for="password">${t.password8}</label><input class="field w" id="password" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="row"><button class="btn primary">${t.submitRegister}</button></div>
    </form>
    <p class="hint">${t.haveAccount}<a href="#/prihlasenie">${T().header.login}</a></p></div>`;
}

function viewReset() {
  const t = T().auth;
  $("#view").innerHTML = `<div class="narrow stack">
    <div class="section-head"><h1>${t.reset}</h1></div>
    <form class="panel stack" data-form="reset">
      <div><label class="l" for="email">${t.email}</label><input class="field w" id="email" name="email" type="email" autocomplete="email" required></div>
      <div class="row"><button class="btn primary">${t.resetSend}</button></div>
    </form></div>`;
}

function viewProfile() {
  const t = T().auth;
  $("#view").innerHTML = `<div class="narrow stack">
    <div class="section-head"><h1>${S.profile ? t.profile : t.finish}</h1></div>
    <form class="panel stack" data-form="profile">${profileFields(S.profile || {})}
      <p class="hint" style="margin:0">${esc(S.user.email || "")}</p>
      <div class="row"><button class="btn primary">${T().common.save}</button></div></form></div>`;
}

/* ---------- udalosti ---------- */

const profileData = (fd) => ({
  name: String(fd.get("name") || "").trim(),
  city: String(fd.get("city") || "").trim(),
  country: fd.get("country") === "CZ" ? "CZ" : "SK",
});

const forms = {
  async login(f, fd) {
    await signInWithEmailAndPassword(auth, String(fd.get("email")).trim(), String(fd.get("password")));
    go("#/");
  },
  async register(f, fd) {
    const p = profileData(fd);
    const cred = await createUserWithEmailAndPassword(auth, String(fd.get("email")).trim(), String(fd.get("password")));
    await setDoc(ref("users", cred.user.uid), newProfile(p));
    go("#/darovat");
  },
  async reset(f, fd) {
    await sendPasswordResetEmail(auth, String(fd.get("email")).trim()).catch((e) => { if (e.code !== "auth/user-not-found") throw e; });
    toast(T().auth.resetSent);
  },
  async profile(f, fd) {
    const p = profileData(fd);
    const r = doc(db, "users", S.user.uid);
    if (S.profile) await updateDoc(r, p);
    else await setDoc(r, newProfile(p));
    toast(T().auth.profileSaved);
    go("#/");
  },
  // Objednávka: v jednej dávke vznikne objednávka, ponuka sa zmení na CLAIMED a príjemcovi ubudne bod.
  async claim(f, fd) {
    const shipTo = {
      fullName: String(fd.get("fullName")).trim(), phone: String(fd.get("phone")).trim(),
      pickupPoint: String(fd.get("pickupPoint")).trim(), email: S.user.email || "",
    };
    store.set("dk-ship", JSON.stringify(shipTo));
    const listingId = location.hash.split("/")[2];
    const ls = await getDoc(ref("listings", listingId));
    const l = ls.data();
    if (!l || l.status !== "AVAILABLE") fail(T().book.gone);
    if ((S.profile.points || 0) < 1) fail(T().book.noPoints);
    const orderId = newId("orders");
    const b = writeBatch(db);
    b.set(ref("orders", orderId), {
      listingId, copyId: l.copyId, title: l.title, author: l.author, color: l.color, condition: l.condition,
      donorUid: l.donorUid, donorName: l.donorName, donorCountry: l.donorCountry,
      recipientUid: S.user.uid, recipientName: S.profile.name, recipientCity: S.profile.city, recipientCountry: S.profile.country,
      shipTo, status: "CREATED", trackingNumber: null, keep: null, rating: null, createdAt: serverTimestamp(),
    });
    b.update(ref("listings", listingId), { status: "CLAIMED", orderId });
    b.update(ref("users", S.user.uid), { points: increment(-1), lastOrder: orderId });
    await b.commit();
    toast(T().book.claimed);
    go("#/vymeny");
  },
  async donate(f, fd) {
    const t = T().donate;
    const file = fd.get("photo");
    const photo = file && file.size ? await shrinkPhoto(file) : null;
    const copyId = newId("copies");
    const listingId = newId("listings");
    const title = String(fd.get("title")).trim();
    const author = String(fd.get("author")).trim();
    const isbn = String(fd.get("isbn") || "").replace(/[^0-9Xx]/g, "").toUpperCase();
    const copy = {
      isbn: isbn.length === 10 || isbn.length === 13 ? isbn : null, title, author,
      genre: fd.get("genre"), language: fd.get("language"),
      color: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
      createdAt: serverTimestamp(), createdBy: S.user.uid,
    };
    const b = writeBatch(db);
    b.set(ref("copies", copyId), copy);
    b.set(ref("listings", listingId), listingData(copyId, copy, String(fd.get("condition")), String(fd.get("note") || "").trim(), photo, null));
    await b.commit();
    await maybeWelcomePoint();
    f.reset();
    $("#isbn-msg").textContent = t.ok;
    toast(t.ok);
  },
  async wish(f, fd) {
    const q = String(fd.get("q") || "").trim();
    if (!q) return;
    await addDoc(collection(db, "wishlist"), { uid: S.user.uid, q, qn: norm(q), createdAt: serverTimestamp() });
    f.reset();
  },
  async sent(f, fd) {
    const tracking = String(fd.get("tracking")).replace(/\s+/g, "");
    await updateDoc(ref("orders", f.dataset.id), { status: "SENT", trackingNumber: tracking, sentAt: serverTimestamp() });
  },
  async note(f, fd) {
    const o = orderCache.get(f.dataset.id);
    await updateDoc(ref("copies", o.copyId, "passport", o.id), { note: String(fd.get("note")).trim() });
    f.reset();
    toast("✓");
  },
};

const newProfile = (p) => ({ ...p, points: 0, welcomeGiven: false, createdAt: serverTimestamp() });

function listingData(copyId, copy, condition, note, photo, prevOrder) {
  return {
    copyId, title: copy.title, author: copy.author, genre: copy.genre, language: copy.language, color: copy.color,
    search: norm(`${copy.title} ${copy.author}`).slice(0, 420), condition, note, photo,
    donorUid: S.user.uid, donorName: S.profile.name, donorCity: S.profile.city, donorCountry: S.profile.country,
    status: "AVAILABLE", orderId: null, prevOrder, createdAt: serverTimestamp(),
  };
}

// Uvítací bod: raz za účet, keď má používateľ dve vlastné ponuky (pravidlá ich overia).
async function maybeWelcomePoint() {
  if (S.profile.welcomeGiven) return;
  const s = await getDocs(query(collection(db, "listings"), where("donorUid", "==", S.user.uid), limit(2)));
  if (s.size < 2) return;
  await updateDoc(ref("users", S.user.uid), { points: increment(1), welcomeGiven: true, welcomeListings: s.docs.map((d) => d.id) });
  toast(T().notif.welcomePoint());
}

// Fotka sa zmenší v prehliadači a uloží priamo do ponuky (bez platiaceho úložiska).
async function shrinkPhoto(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 720 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  for (const q of [0.75, 0.6, 0.45]) {
    const url = c.toDataURL("image/jpeg", q);
    if (url.length < 280000) return url;
  }
  fail(T().donate.photoBig);
}

document.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  if (!f.checkValidity()) { f.reportValidity(); return; }
  const fd = new FormData(f); // pred zablokovaním: zablokované polia FormData vynecháva
  busy(f, true);
  try {
    await forms[f.dataset.form](f, fd);
  } catch (err) {
    console.error(err);
    toast(err.shown ? err.message : errText(err), true);
  } finally {
    busy(f, false);
  }
});

const actions = {
  async logout() {
    routeSubs.forEach((u) => u());
    routeSubs = [];
    await signOut(auth);
    go("#/");
  },
  lang(el) { store.set("dk-lang", el.dataset.lang); route(); },
  async isbn() {
    const t = T().donate;
    const msg = $("#isbn-msg");
    msg.textContent = t.loading;
    const hit = await lookupIsbn($("#isbn").value);
    if (!hit) { msg.textContent = t.notFound; return; }
    $("#isbn").value = hit.isbn;
    $("#title").value = hit.title;
    $("#author").value = hit.author;
    msg.textContent = `${t.loaded} ${hit.title}`;
  },
  async withdraw(el) { await updateDoc(ref("listings", el.dataset.id), { status: "WITHDRAWN" }); },
  async unwish(el) { await deleteDoc(ref("wishlist", el.dataset.id)); },
  // Vyzdvihnutie: objednávka, ponuka, bod pre darcu a záznam v pase knihy naraz.
  async pickup(el) {
    const o = orderCache.get(el.dataset.id);
    const b = writeBatch(db);
    b.update(ref("orders", o.id), { status: "PICKED_UP", pickedUpAt: serverTimestamp() });
    b.update(ref("listings", o.listingId), { status: "DELIVERED" });
    b.update(ref("users", o.donorUid), { points: increment(1), sentCount: increment(1), lastDelivered: o.id });
    b.set(ref("copies", o.copyId, "passport", o.id), {
      uid: S.user.uid, name: S.profile.name, city: S.profile.city, country: S.profile.country, note: "", createdAt: serverTimestamp(),
    });
    await b.commit();
  },
  async cancel(el) {
    const o = orderCache.get(el.dataset.id);
    const by = o.donorUid === S.user.uid ? "donor" : "recipient";
    const b = writeBatch(db);
    b.update(ref("orders", o.id), { status: "CANCELLED", cancelledAt: serverTimestamp(), cancelledBy: by });
    b.update(ref("listings", o.listingId), { status: "WITHDRAWN" });
    b.update(ref("users", o.recipientUid), { points: increment(1), lastRefund: o.id });
    await b.commit();
  },
  async keep(el) {
    const o = orderCache.get(el.dataset.id);
    if (el.dataset.value === "KEEP") {
      await updateDoc(ref("orders", o.id), { keep: "KEEP" });
      return;
    }
    // Pošlem ďalej: nová ponuka toho istého exempláru (pas knihy pokračuje).
    const copy = (await getDoc(ref("copies", o.copyId))).data();
    const listingId = newId("listings");
    const b = writeBatch(db);
    b.set(ref("listings", listingId), listingData(o.copyId, copy, o.condition, "", null, o.id));
    b.update(ref("orders", o.id), { keep: "PASS", passListing: listingId });
    await b.commit();
    toast(T().ex.passed);
  },
  async rate(el) {
    const o = orderCache.get(el.dataset.id);
    const rating = Number(el.dataset.value);
    const b = writeBatch(db);
    b.update(ref("orders", o.id), { rating });
    b.update(ref("users", o.donorUid), { ratingSum: increment(rating), ratingCount: increment(1), lastRated: o.id });
    await b.commit();
  },
};

document.addEventListener("click", async (e) => {
  const chip = e.target.closest("[data-filter]");
  if (chip) { catalogFilter[chip.dataset.filter] = chip.dataset.value; route(); return; }
  const el = e.target.closest("[data-action], [data-lang]");
  if (!el) return;
  const name = el.dataset.lang ? "lang" : el.dataset.action;
  if (!actions[name]) return;
  el.disabled = true;
  try {
    await actions[name](el);
  } catch (err) {
    console.error(err);
    toast(errText(err), true);
  } finally {
    el.disabled = false;
  }
});

renderHeader();
if (!configured) { S.ready = true; route(); }
