// DarujKnihu.sk – statický web (GitHub Pages) napojený na Firebase.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, limit, onSnapshot, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { getStorage, ref as sref, uploadBytes, getDownloadURL, connectStorageEmulator } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { firebaseConfig, useEmulators } from "./firebase-config.js";
import { DICT } from "./i18n.js";
import { GENRES, CONDITIONS, LANGUAGES, RESERVATION_HOURS, SEND_DEADLINE_DAYS } from "./constants.js";

/* ---------- Firebase ---------- */

const configured = useEmulators || !String(firebaseConfig.apiKey).startsWith("DOPLNIT");
// Emulátory bežia pod offline projektom demo-darujknihu (firebase emulators:start --project demo-darujknihu).
const app = initializeApp(useEmulators
  ? { ...firebaseConfig, apiKey: "demo-key", projectId: "demo-darujknihu", storageBucket: "demo-darujknihu.appspot.com" }
  : firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, "europe-west1");
const storage = getStorage(app);
if (useEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
}
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

/* ---------- stav a pomocné ---------- */

const S = { user: null, profile: null, unread: 0, ready: false, flash: null };
let routeSubs = [];
let userSubs = [];
const catalogFilter = { q: "", genre: "", lang: "" };

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
const errText = (e) => T().auth.errors[e?.code] || (e?.code?.startsWith?.("functions/") ? e.message : T().common.error);
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
    return `<a class="tab" href="#${h}" ${active ? 'aria-current="page"' : ""}>${label}</a>`;
  }).join("");
  const l = lang();
  const langs = `<span class="langs" role="group" aria-label="Jazyk"><button data-lang="sk" aria-pressed="${l === "sk"}">SK</button><button data-lang="cs" aria-pressed="${l === "cs"}">CZ</button></span>`;
  if (S.user && S.profile) {
    const p = S.profile.points || 0;
    $("#wallet").innerHTML = `${langs}
      <a class="pill points" href="#/vymeny"><b>${p}</b> ${t.pts(p).replace(/^\d+ /, "")}</a>
      <a class="pill" href="#/upozornenia" aria-label="${esc(t.header.notifications)}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        <b>${S.unread}</b></a>
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
  const needAuth = ["darovat", "wishlist", "vymeny", "upozornenia", "profil"];
  if (needAuth.includes(seg) && !S.user) return go("#/prihlasenie");
  if (S.user && !S.profile && seg !== "profil") return go("#/profil");
  const view = {
    "": viewCatalog, kniha: () => viewBook(id), darovat: viewDonate, wishlist: viewWishlist, vymeny: viewExchanges,
    upozornenia: viewNotifications, prihlasenie: viewLogin, registracia: viewRegister, heslo: viewReset, profil: viewProfile,
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
  S.unread = 0;
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
  userSubs.push(onSnapshot(query(collection(db, "notifications"), where("uid", "==", user.uid), where("read", "==", false)), (s) => {
    S.unread = s.size;
    renderHeader();
  }));
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
            ${l.photoUrl ? `<a href="${esc(l.photoUrl)}" target="_blank" rel="noopener"><img class="photo-prev" src="${esc(l.photoUrl)}" alt=""></a>` : ""}
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
    <div class="section-head"><div><h1>${t.title}</h1><p class="sub">${t.sub(RESERVATION_HOURS)}</p></div></div>
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
    $(el).innerHTML = list.length ? `<div class="list">${list.map(render).join("")}</div>` : `<div class="empty">${empty}</div>`;
  }, () => toast(T().common.error, true)));
  sub("recipientUid", "#incoming", incoming, t.noIncoming);
  sub("donorUid", "#outgoing", outgoing, t.noOutgoing);
}

/* ---------- upozornenia ---------- */

function viewNotifications() {
  const t = T().notif;
  $("#view").innerHTML = `<div class="stack" style="max-width:680px">
    <div class="section-head"><h1>${t.title}</h1><button class="btn small" data-action="readall">${t.markAll}</button></div>
    <div class="panel" style="padding:0;overflow:hidden" id="notifs"><p class="hint" style="padding:16px">${T().common.loading}</p></div></div>`;
  routeSubs.push(onSnapshot(query(collection(db, "notifications"), where("uid", "==", S.user.uid), limit(100)), (s) => {
    const list = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    $("#notifs").innerHTML = list.length ? list.map((n) => {
      const text = (T().notif[n.type] || (() => n.type))(n.params || {});
      const when = n.createdAt ? n.createdAt.toDate().toLocaleString(T().locale, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="notif ${n.read ? "" : "unread"}">${n.href ? `<a href="${esc(n.href)}" style="color:inherit">${esc(text)}</a>` : esc(text)}<time>${when}</time></div>`;
    }).join("") : `<p class="empty" style="margin:16px">${t.empty}</p>`;
  }));
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
    await setDoc(doc(db, "users", cred.user.uid), { ...p, createdAt: serverTimestamp() });
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
    else await setDoc(r, { ...p, createdAt: serverTimestamp() });
    toast(T().auth.profileSaved);
    go("#/");
  },
  async claim(f, fd) {
    const data = { fullName: fd.get("fullName"), phone: fd.get("phone"), pickupPoint: fd.get("pickupPoint") };
    store.set("dk-ship", JSON.stringify(data));
    const id = location.hash.split("/")[2];
    await call("claimListing", { listingId: id, ...data });
    toast(T().book.claimed);
    go("#/vymeny");
  },
  async donate(f, fd) {
    const t = T().donate;
    const file = fd.get("photo");
    let photoUrl = null;
    if (file && file.size) {
      if (file.size > 3 * 1024 * 1024) throw Object.assign(new Error(t.photoBig), { shown: true });
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type] || "jpg";
      const r = sref(storage, `listings/${S.user.uid}/${crypto.randomUUID()}.${ext}`);
      await uploadBytes(r, file, { contentType: file.type });
      photoUrl = await getDownloadURL(r);
    }
    await call("createListing", {
      isbn: fd.get("isbn") || null, title: fd.get("title"), author: fd.get("author"), genre: fd.get("genre"),
      language: fd.get("language"), condition: fd.get("condition"), note: fd.get("note") || "", photoUrl,
    });
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
    await call("markSent", { orderId: f.dataset.id, trackingNumber: fd.get("tracking") });
  },
  async note(f, fd) {
    await call("addPassportNote", { orderId: f.dataset.id, note: fd.get("note") });
    f.reset();
    toast("✓");
  },
};

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
  async withdraw(el) { await call("withdrawListing", { listingId: el.dataset.id }); },
  async unwish(el) { await deleteDoc(doc(db, "wishlist", el.dataset.id)); },
  async pickup(el) { await call("confirmPickup", { orderId: el.dataset.id }); },
  async cancel(el) { await call("cancelOrder", { orderId: el.dataset.id }); },
  async keep(el) {
    await call("setKeep", { orderId: el.dataset.id, choice: el.dataset.value });
    if (el.dataset.value === "PASS") toast(T().ex.passed);
  },
  async rate(el) { await call("rateOrder", { orderId: el.dataset.id, rating: Number(el.dataset.value) }); },
  async readall() {
    const s = await getDocs(query(collection(db, "notifications"), where("uid", "==", S.user.uid), where("read", "==", false)));
    const b = writeBatch(db);
    s.docs.forEach((d) => b.update(d.ref, { read: true }));
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
