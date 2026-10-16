// DarujKnihu.sk – statický web (GitHub Pages) napojený na Firebase (bezplatný plán Spark).
// Bez Cloud Functions: každý krok výmeny je dávka zápisov a firestore.rules ju pustia,
// len keď sedí celá (objednávka, ponuka aj body naraz).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc,
  collection, query, where, limit, onSnapshot, serverTimestamp, writeBatch, increment,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig, useEmulators } from "./firebase-config.js";
import { DICT } from "./i18n.js";
import { GENRES, CONDITIONS, LANGUAGES, SEND_DEADLINE_DAYS, REPORT_REASONS } from "./constants.js";
import { parseCode, lookupIsbn, startScanner } from "./isbn.js";

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

const S = { user: null, profile: null, admin: false, todo: 0, ready: false };
let routeSubs = [];
let userSubs = [];
const catalogFilter = { q: "", genre: "", lang: "", place: "" };
const orderCache = new Map();
let bulkQueue = []; // hromadné darovanie: [{ code, isbn, title, author, cover, genre, language, condition, state }]

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
const errText = (e) => T().auth.errors[e?.code] || (e?.shown ? e.message : S.profile?.blocked ? T().common.blocked : T().common.error);
const fail = (msg) => { throw Object.assign(new Error(msg), { shown: true }); };
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// Obálka: skutočná fotka obálky, ak ju máme; inak farebná obálka s názvom (zostane aj pod obrázkom, keby sa nenačítal).
function cover(l, size = "") {
  const img = l.cover ? `<img class="real" src="${esc(l.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  return `<div class="cover ${size}" style="background:${esc(l.color)}" aria-hidden="true">
    <div><div class="t">${esc(l.title)}</div><div class="rule"></div></div><div class="a">${esc(l.author)}</div>${img}</div>`;
}

function busy(form, on) {
  form.querySelectorAll("button, input, select, textarea").forEach((el) => (el.disabled = on));
}

// Verejné anonymné záznamy z wishlistov: koľko ľudí čaká na danú knihu.
const waitingFor = (l, wants) => wants.filter((w) => w.qn && l.search.includes(w.qn)).length;
const watchWants = (cb) => routeSubs.push(onSnapshot(query(collection(db, "wants"), limit(2000)), (s) => cb(s.docs.map((d) => d.data())), () => {}));

/* ---------- hlavička ---------- */

function renderHeader() {
  const t = T();
  const path = location.hash.replace(/^#/, "") || "/";
  const tabs = [["/", t.nav.catalog], ["/darovat", t.nav.donate], ["/wishlist", t.nav.wishlist], ["/vymeny", t.nav.exchanges]];
  if (S.admin) tabs.push(["/sprava", t.header.admin]);
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
  closeScanner();
  routeSubs.forEach((u) => u());
  routeSubs = [];
  renderHeader();
  if (!S.ready) return;
  const path = location.hash.replace(/^#/, "") || "/";
  const [, seg, id] = path.split("/");
  const needAuth = ["darovat", "wishlist", "vymeny", "profil", "sprava"];
  if (needAuth.includes(seg) && !S.user) return go("#/prihlasenie");
  if (S.registering) return; // profil sa práve ukladá, smerovanie dokončí registrácia
  if (S.user && !S.profile && seg !== "profil") return go("#/profil");
  const view = {
    "": viewCatalog, kniha: () => viewBook(id), darovat: () => viewDonate(id === "hromadne"), wishlist: viewWishlist,
    vymeny: viewExchanges, sprava: viewAdmin,
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
  S.admin = false;
  S.todo = 0;
  if (!user) {
    S.ready = true;
    return route();
  }
  // Kým sa nenačíta profil, nič nesmerujeme (inak by prihlásený skončil na stránke Profil).
  S.ready = false;
  $("#view").innerHTML = `<p class="center">${T().common.loading}</p>`;
  let first = true;
  // Hneď po registrácii môže prvé čítanie prísť skôr než prihlasovací token a pravidlá ho odmietnu;
  // vtedy sa odber po chvíli obnoví, inak by web zostal na „Dokončite profil“.
  const watchProfile = () => userSubs.push(onSnapshot(ref("users", user.uid), (snap) => {
    const hadProfile = !!S.profile;
    S.profile = snap.exists() ? snap.data() : null;
    renderHeader();
    if (first || hadProfile !== !!S.profile) { first = false; S.ready = true; route(); }
  }, () => { if (auth.currentUser?.uid === user.uid) setTimeout(watchProfile, 800); }));
  watchProfile();
  getDoc(ref("admins", user.uid)).then((s) => { S.admin = s.exists(); renderHeader(); }).catch(() => {});
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

// Odporúčania: autori a žánre z prečítaných kníh a z wishlistu, jazyk čitateľa.
function recommend(listings, received, wishes) {
  const uid = S.user?.uid;
  if (!uid || (!received.length && !wishes.length)) return [];
  const authors = new Set(received.map((o) => norm(o.author)));
  const genres = new Map();
  received.forEach((o) => o.genre && genres.set(o.genre, (genres.get(o.genre) || 0) + 1));
  const myLang = S.profile?.country === "CZ" ? "cs" : "sk";
  const seen = new Set(received.map((o) => o.copyId));
  return listings
    .filter((l) => l.donorUid !== uid && !seen.has(l.copyId))
    .map((l) => {
      let score = 0;
      if (authors.has(norm(l.author))) score += 3;
      if (wishes.some((w) => w.qn && norm(l.author).includes(w.qn))) score += 3;
      score += Math.min(2, genres.get(l.genre) || 0);
      if (score && (l.language === myLang || l.language === (myLang === "sk" ? "cs" : "sk"))) score += 0.5;
      return { l, score };
    })
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score || ms(b.l.createdAt) - ms(a.l.createdAt))
    .slice(0, 6)
    .map((x) => x.l);
}

function card(l, { onWish = false, waiting = 0 } = {}) {
  const t = T().home;
  const tt = T();
  const uid = S.user?.uid;
  return `<a class="card ${onWish ? "match" : ""}" href="#/kniha/${l.id}">
    ${cover(l)}
    <div class="meta">
      <span class="title">${esc(l.title)}</span><span class="author">${esc(l.author)}</span>
      <div class="row">
        ${onWish ? `<span class="tag hot">${t.fromWish}</span>` : ""}
        ${l.donorUid === uid ? `<span class="tag good">${t.yours}</span>` : ""}
        ${waiting ? `<span class="tag hot">${t.waiting(waiting)}</span>` : ""}
        <span class="tag">${esc(condLabel(l.condition))}</span>
        ${l.language !== lang() ? `<span class="tag">${esc(tt.languages[l.language] || l.language)}</span>` : ""}
      </div>
      <span class="donor">${esc(l.donorName)}, ${esc(l.donorCity)} · ${esc(l.donorCountry)}</span>
    </div></a>`;
}

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
    <section class="rec" id="rec" hidden></section>
    <div class="section-head"><div><h2>${t.catalog}</h2><p class="sub" id="count">${T().common.loading}</p></div></div>
    <div class="filters"><input class="field" type="search" id="q" placeholder="${esc(t.search)}" aria-label="${esc(t.search)}" value="${esc(catalogFilter.q)}"></div>
    <div class="chips" id="place-chips" style="margin-bottom:8px"></div>
    <div class="chips" id="lang-chips" style="margin-bottom:8px"></div>
    <div class="chips" id="genre-chips" style="margin-bottom:20px"></div>
    <div id="grid"></div>`;
  let listings = [];
  let wishes = [];
  let wants = [];
  let received = [];
  const chips = (el, key, options) => {
    $(el).innerHTML = options.map(([v, label]) =>
      `<button class="chip" data-filter="${key}" data-value="${esc(v)}" aria-current="${catalogFilter[key] === v}">${esc(label)}</button>`).join("");
  };
  const draw = () => {
    const tt = T();
    const places = Object.entries(t.place).filter(([k]) => k !== "city" || S.profile);
    chips("#place-chips", "place", places);
    chips("#lang-chips", "lang", [["", t.allLangs], ...LANGUAGES.map((l) => [l, tt.languages[l]])]);
    chips("#genre-chips", "genre", [["", t.allGenres], ...GENRES.map((g) => [g, genreLabel(g)])]);
    const q = norm(catalogFilter.q);
    const wq = wishes.map((w) => w.qn).filter(Boolean);
    const uid = S.user?.uid;
    const myCity = norm(S.profile?.city || "");
    const place = catalogFilter.place;
    const items = listings
      .filter((l) => (!catalogFilter.genre || l.genre === catalogFilter.genre) && (!catalogFilter.lang || l.language === catalogFilter.lang))
      .filter((l) => !place || (place === "city" ? norm(l.donorCity) === myCity : l.donorCountry === place))
      .filter((l) => !q || l.search.includes(q))
      .map((l) => ({ l, onWish: l.donorUid !== uid && wq.some((w) => l.search.includes(w)) }))
      .sort((a, b) => Number(b.onWish) - Number(a.onWish) || ms(b.l.createdAt) - ms(a.l.createdAt));
    $("#count").textContent = t.count(items.length);
    $("#grid").innerHTML = items.length
      ? `<div class="grid">${items.map(({ l, onWish }) => card(l, { onWish, waiting: waitingFor(l, wants) })).join("")}</div>`
      : `<div class="empty">${t.empty}</div>`;
    const recs = !q && !catalogFilter.genre && !catalogFilter.lang && !place ? recommend(listings, received, wishes) : [];
    $("#rec").hidden = !recs.length;
    if (recs.length) {
      $("#rec").innerHTML = `<div class="section-head"><div><h2>${t.rec}</h2><p class="sub">${t.recSub}</p></div></div>
        <div class="grid">${recs.map((l) => card(l, { waiting: waitingFor(l, wants) })).join("")}</div>`;
    }
  };
  if (!configured) { $("#count").textContent = ""; draw(); return; }
  routeSubs.push(onSnapshot(query(collection(db, "listings"), where("status", "==", "AVAILABLE"), limit(500)), (s) => {
    listings = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => toast(T().common.error, true)));
  watchWants((w) => { wants = w; draw(); });
  if (S.user) {
    routeSubs.push(onSnapshot(query(collection(db, "wishlist"), where("uid", "==", S.user.uid)), (s) => {
      wishes = s.docs.map((d) => d.data());
      draw();
    }, () => {}));
    routeSubs.push(onSnapshot(query(collection(db, "orders"), where("recipientUid", "==", S.user.uid)), (s) => {
      received = s.docs.map((d) => d.data()).filter((o) => o.status !== "CANCELLED");
      draw();
    }, () => {}));
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
  let wants = [];
  let delivery = store.get("dk-delivery") === "PERSONAL" ? "PERSONAL" : "PACKETA";
  const draw = () => {
    const tt = T();
    if (!l) { $("#view").innerHTML = `<p class="center"><a href="#/">${tt.common.back}</a></p>`; return; }
    const uid = S.user?.uid;
    const points = S.profile?.points || 0;
    const saved = JSON.parse(store.get("dk-ship") || "{}");
    const waiting = waitingFor(l, wants);
    const stats = donor
      ? donor.ratingCount ? tb.rating((donor.ratingSum / donor.ratingCount).toFixed(1), donor.sentCount || 0) : tb.sentOnly(donor.sentCount || 0)
      : "";
    const pickupUrl = S.profile?.country === "CZ" ? "https://www.zasilkovna.cz" : "https://www.packeta.sk";
    const personal = delivery === "PERSONAL";
    let claim;
    if (l.status !== "AVAILABLE") claim = `<div class="claim"><b>${tb.gone}</b></div>`;
    else if (l.donorUid === uid) claim = `<div class="claim"><span>${tb.mine}</span></div>`;
    else if (!S.user) claim = `<div class="claim"><span>${tb.loginToClaim}</span><div class="row"><a class="btn primary" href="#/prihlasenie">${tt.header.login}</a><a class="btn" href="#/registracia">${tt.header.register}</a></div></div>`;
    else if (points < 1) claim = `<div class="claim"><div class="warnbox">${tb.noPoints}</div><div class="row"><a class="btn primary" href="#/darovat">${tt.nav.donate}</a></div></div>`;
    else claim = `
      <form class="claim" data-form="claim">
        <div><span class="l">${tb.delivery}</span><div class="radios">
          <span><input type="radio" name="delivery" id="d-p" value="PACKETA" ${personal ? "" : "checked"} data-action="delivery"><label for="d-p">${tb.byPacketa}</label></span>
          <span><input type="radio" name="delivery" id="d-o" value="PERSONAL" ${personal ? "checked" : ""} data-action="delivery"><label for="d-o">${tb.byPerson}</label></span>
        </div></div>
        ${personal ? `<p class="note" style="margin:0">${esc(tb.personalHint(l.donorCity))}</p>` : `<b>${tb.claimTitle}</b>`}
        <div><label class="l" for="c-name">${personal ? tb.contactName : tb.fullName}</label><input class="field w" id="c-name" name="fullName" required minlength="3" maxlength="80" autocomplete="name" value="${esc(saved.fullName || "")}"></div>
        <div><label class="l" for="c-phone">${tb.phone}</label><input class="field w" id="c-phone" name="phone" type="tel" required minlength="9" maxlength="20" autocomplete="tel" value="${esc(saved.phone || "")}"></div>
        ${personal ? "" : `<div><label class="l" for="c-point">${tb.pickup}</label><input class="field w" id="c-point" name="pickupPoint" required minlength="3" maxlength="200" value="${esc(saved.pickupPoint || "")}">
          <p class="hint" style="margin:6px 0 0">${tb.pickupHint} <a href="${pickupUrl}" target="_blank" rel="noopener">${tb.pickupLink}</a>.</p></div>`}
        <p class="note" style="margin:0">${tb.privacy}${personal ? "" : ` ${tb.cost}`}</p>
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
            </div>
            ${waiting ? `<p class="note" style="margin:0;color:var(--stamp)">${tb.waiting(waiting)}</p>` : ""}
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
  viewBook.setDelivery = (v) => {
    // zachová rozpísané údaje pri prepnutí spôsobu prevzatia
    const keep = { fullName: $("#c-name")?.value, phone: $("#c-phone")?.value, pickupPoint: $("#c-point")?.value };
    const saved = JSON.parse(store.get("dk-ship") || "{}");
    store.set("dk-ship", JSON.stringify({ ...saved, ...Object.fromEntries(Object.entries(keep).filter(([, x]) => x)) }));
    delivery = v;
    store.set("dk-delivery", v);
    draw();
  };
  routeSubs.push(onSnapshot(ref("listings", id), async (snap) => {
    l = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (l) {
      const ps = await getDocs(collection(db, "copies", l.copyId, "passport"));
      passport = ps.docs.map((d) => d.data()).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
      if (S.user && !donor) donor = (await getDoc(ref("users", l.donorUid))).data() || null;
    }
    draw();
  }, () => toast(T().common.error, true)));
  watchWants((w) => { wants = w; if (l) draw(); });
}

/* ---------- darovanie ---------- */

const scanIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="vertical-align:-3px"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>`;
const options = (list, label, selected) => list.map((v) => `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(label(v))}</option>`).join("");

function viewDonate(bulk) {
  const t = T().donate;
  const tt = T();
  const defLang = S.profile.country === "CZ" ? "cs" : "sk";
  const modes = `<div class="chips" style="margin-bottom:16px">
    <a class="chip" href="#/darovat" aria-current="${!bulk}">${t.modeOne}</a>
    <a class="chip" href="#/darovat/hromadne" aria-current="${bulk}">${t.modeBulk}</a></div>`;
  const single = `
      <form class="panel stack" data-form="donate" novalidate>
        <div><label class="l" for="isbn">${t.isbn}</label>
          <div class="isbn-row"><input class="field" id="isbn" name="isbn" inputmode="numeric" placeholder="978…" autocomplete="off">
          <button class="btn" type="button" data-action="isbn">${t.load}</button></div>
          <button class="btn small" type="button" data-action="scan" style="margin-top:8px">${scanIcon} ${t.scan}</button>
          <p class="hint" id="isbn-msg" role="status" style="margin:6px 0 0">${t.isbnHint}</p>
          <input type="hidden" id="cover" name="cover"><div id="cover-prev"></div></div>
        <div><label class="l" for="title">${t.titleF}</label><input class="field w" id="title" name="title" required maxlength="200"></div>
        <div><label class="l" for="author">${t.author}</label><input class="field w" id="author" name="author" required maxlength="200"></div>
        <div><label class="l" for="genre">${t.genre}</label><select class="field w" id="genre" name="genre">${options(GENRES, genreLabel)}</select></div>
        <div><label class="l" for="language">${t.language}</label><select class="field w" id="language" name="language">${options(LANGUAGES, (l) => tt.languages[l], defLang)}</select></div>
        <div><span class="l">${t.condition}</span><div class="radios">${CONDITIONS.map((c, i) => `<span><input type="radio" name="condition" id="cond-${i}" value="${esc(c)}" ${i === 1 ? "checked" : ""}><label for="cond-${i}">${esc(condLabel(c))}</label></span>`).join("")}</div></div>
        <div><label class="l" for="note">${t.note}</label><textarea class="field w" id="note" name="note" maxlength="300" placeholder="${esc(t.notePh)}"></textarea></div>
        <div><label class="l" for="photo">${t.photo}</label><input type="file" id="photo" name="photo" accept="image/jpeg,image/png,image/webp"></div>
        <div class="row"><button class="btn primary" id="donate-btn">${t.submit}</button></div>
      </form>`;
  const many = `
      <div class="panel stack">
        <p class="sub" style="margin:0">${t.bulkHint}</p>
        <form class="stack" data-form="bulkcodes" style="gap:8px">
          <label class="l" for="codes" style="margin:0">${t.bulkCodes}</label>
          <textarea class="field w mono" id="codes" name="codes" rows="4" placeholder="9788055607900&#10;9788072445318"></textarea>
          <div class="row"><button class="btn">${t.bulkAdd}</button>
            <button class="btn small" type="button" data-action="bulkscan">${scanIcon} ${t.bulkScan}</button></div>
        </form>
        <div id="bulk-list"></div>
        <div class="row"><button class="btn primary" data-action="bulksave" id="bulk-save" hidden></button></div>
      </div>`;
  $("#view").innerHTML = `
    <div class="section-head"><div><h1>${t.title}</h1><p class="sub">${t.sub}</p></div></div>
    ${modes}
    <div class="two">
      ${bulk ? many : single}
      <div class="stack"><h2 style="font-size:20px">${t.mine}</h2><div id="mine"><p class="hint">${tt.common.loading}</p></div></div>
    </div>`;
  if (bulk) drawBulk();
  let mine = [];
  let wants = [];
  const drawMine = () => {
    $("#mine").innerHTML = mine.length ? `<div class="list">${mine.map((l) => {
      const waiting = l.status === "AVAILABLE" ? waitingFor(l, wants) : 0;
      return `<div class="order">${cover(l, "mini")}<div class="stack" style="gap:6px;min-width:0">
        <h3><a href="#/kniha/${l.id}" style="color:inherit">${esc(l.title)}</a></h3>
        <span class="donor">${esc(l.author)} · ${esc(condLabel(l.condition))}</span>
        <div class="row"><span class="tag ${l.status === "DELIVERED" ? "good" : l.status === "CLAIMED" ? "hot" : ""}">${t.status[l.status] || l.status}</span>
        ${waiting ? `<span class="tag hot">${t.waiting(waiting)}</span>` : ""}
        ${l.status === "AVAILABLE" ? `<button class="linkbtn note" data-action="withdraw" data-id="${l.id}">${t.withdraw}</button>` : ""}</div>
      </div></div>`;
    }).join("")}</div>` : `<div class="empty">${t.none}</div>`;
  };
  routeSubs.push(onSnapshot(query(collection(db, "listings"), where("donorUid", "==", S.user.uid)), (s) => {
    mine = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    drawMine();
  }));
  watchWants((w) => { wants = w; drawMine(); });
}

// Načíta údaje o knihe podľa ISBN/EAN v políčku a vyplní názov, autora a obálku.
async function fillFromCode(raw) {
  const t = T().donate;
  const msg = $("#isbn-msg");
  const code = parseCode(raw);
  $("#cover").value = "";
  $("#cover-prev").innerHTML = "";
  if (code.invalid) { msg.textContent = t.invalidCode; return; }
  if (code.ean) { msg.textContent = t.notBook(code.ean); return; }
  $("#isbn").value = code.isbn;
  msg.textContent = t.loading;
  const hit = await lookupIsbn(code.isbn);
  if (!hit) { msg.textContent = t.notFound; return; }
  $("#title").value = hit.title;
  $("#author").value = hit.author;
  msg.textContent = `${t.loaded} ${hit.title}${hit.cover ? ` ${t.coverFound}` : ""}`;
  if (hit.cover) {
    $("#cover").value = hit.cover;
    $("#cover-prev").innerHTML = `<img class="cover-prev" src="${esc(hit.cover)}" alt="" referrerpolicy="no-referrer" style="margin-top:8px">`;
  }
}

/* ---------- hromadné darovanie ---------- */

function drawBulk() {
  const t = T().donate;
  const tt = T();
  const list = $("#bulk-list");
  if (!list) return;
  list.innerHTML = bulkQueue.length ? bulkQueue.map((b, i) => `
    <div class="bulk-row">
      ${cover({ title: b.title || "?", author: b.author, color: b.color, cover: b.cover }, "mini")}
      <div class="bulk-fields">
        <span class="mono">${esc(b.isbn || b.code)} · ${b.state === "loading" ? t.loading : b.state === "missing" ? t.notFound : b.state === "ean" ? t.notBook(b.code) : ""}</span>
        <input class="field" data-bulk="${i}" data-key="title" value="${esc(b.title)}" placeholder="${esc(t.titleF)}" aria-label="${esc(t.titleF)}">
        <input class="field" data-bulk="${i}" data-key="author" value="${esc(b.author)}" placeholder="${esc(t.author)}" aria-label="${esc(t.author)}">
        <select class="field" data-bulk="${i}" data-key="genre" aria-label="${esc(t.genre)}">${options(GENRES, genreLabel, b.genre)}</select>
        <select class="field" data-bulk="${i}" data-key="language" aria-label="${esc(t.language)}">${options(LANGUAGES, (l) => tt.languages[l], b.language)}</select>
        <select class="field" data-bulk="${i}" data-key="condition" aria-label="${esc(t.condition)}">${options(CONDITIONS, condLabel, b.condition)}</select>
      </div>
      <button class="btn small ghost" type="button" data-action="bulkremove" data-id="${i}" aria-label="${esc(tt.common.remove)}">×</button>
    </div>`).join("") : `<p class="hint">${t.bulkEmpty}</p>`;
  const btn = $("#bulk-save");
  btn.hidden = !bulkQueue.length;
  btn.textContent = t.bulkSave(bulkQueue.length);
}

async function addBulkCode(raw) {
  const t = T().donate;
  const code = parseCode(raw);
  const key = code.isbn || code.ean || String(raw).trim();
  if (!key || code.invalid) { if (String(raw).trim()) toast(`${t.invalidCode} (${String(raw).trim()})`, true); return; }
  if (bulkQueue.some((b) => (b.isbn || b.code) === key)) { toast(t.bulkDup); return; }
  const item = {
    code: key, isbn: code.isbn || null, title: "", author: "", cover: null,
    color: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
    genre: GENRES[0], language: S.profile.country === "CZ" ? "cs" : "sk", condition: CONDITIONS[1],
    state: code.isbn ? "loading" : "ean",
  };
  bulkQueue.push(item);
  drawBulk();
  if (!code.isbn) return;
  const hit = await lookupIsbn(code.isbn);
  Object.assign(item, hit ? { title: hit.title, author: hit.author, cover: hit.cover, state: "ok" } : { state: "missing" });
  drawBulk();
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

function track(o) {
  const steps = ["CREATED", "SENT", "PICKED_UP"];
  const labels = o.delivery === "PERSONAL" ? T().ex.stepsPerson : T().ex.steps;
  const idx = steps.indexOf(o.status);
  return `<ol class="track" style="grid-template-columns:repeat(3,1fr)">${steps.map((s, i) =>
    `<li class="${i < idx || o.status === "PICKED_UP" ? "done" : i === idx ? "now" : ""}">${labels[s]}</li>`).join("")}</ol>`;
}
const trackUrl = (n) => `https://tracking.packeta.com/${lang() === "cs" ? "cs" : "sk"}/?id=${encodeURIComponent(n)}`;

function reportBox(o, role, reports) {
  const t = T().ex;
  const r = reports.find((x) => x.orderId === o.id);
  if (r) return `<p class="note" style="margin:8px 0 0">${r.status === "RESOLVED" ? t.reportResolved : t.reported}${r.adminNote ? ` – „${esc(r.adminNote)}“` : ""}</p>`;
  const reasons = REPORT_REASONS.filter((x) => (role === "donor" ? x === "NOT_PICKED_UP" || x === "OTHER" : x !== "NOT_PICKED_UP"));
  return `<details class="report"><summary>${t.report}</summary>
    <form class="stack" data-form="report" data-id="${o.id}" data-role="${role}" style="gap:8px">
      <label class="l" for="r-${o.id}" style="margin:0">${t.reportReason}</label>
      <select class="field w" id="r-${o.id}" name="reason">${reasons.map((x) => `<option value="${x}">${t.reasons[x]}</option>`).join("")}</select>
      <textarea class="field w" name="text" maxlength="1000" placeholder="${esc(t.reportText)}" aria-label="${esc(t.reportText)}"></textarea>
      <div class="row"><button class="btn small">${t.reportSend}</button></div>
    </form></details>`;
}

function viewExchanges() {
  const t = T().ex;
  $("#view").innerHTML = `
    <div class="section-head"><div><h1>${t.title}</h1><p class="sub">${t.have(T().pts(S.profile.points || 0))}</p></div></div>
    <div class="two">
      <section class="stack"><h2 style="font-size:20px">${t.incoming}</h2><div id="incoming"><p class="hint">${T().common.loading}</p></div></section>
      <section class="stack"><h2 style="font-size:20px">${t.outgoing}</h2><div id="outgoing"><p class="hint">${T().common.loading}</p></div></section>
    </div>`;
  let reports = [];
  const lists = { incoming: [], outgoing: [] };
  const deadline = (o) => fmtDate(new Date(ms(o.createdAt) + SEND_DEADLINE_DAYS * 86400e3));
  const contact = (s) => `<dl class="ship"><dt>${t.shipName}</dt><dd>${esc(s.fullName)}</dd><dt>${t.shipPhone}</dt><dd>${esc(s.phone)}</dd><dt>${t.shipEmail}</dt><dd>${esc(s.email)}</dd>${s.pickupPoint ? `<dt>${t.shipPoint}</dt><dd>${esc(s.pickupPoint)}</dd>` : ""}</dl>`;
  const incoming = (o) => {
    const personal = o.delivery === "PERSONAL";
    let body = o.status === "CANCELLED" ? `<p class="warnbox" style="margin-top:10px">${t.cancelled}</p>` : track(o);
    if (o.status === "CREATED") {
      const late = Date.now() - ms(o.createdAt) > SEND_DEADLINE_DAYS * 86400e3;
      if (personal) body += `<p class="note" style="margin:0 0 8px">${esc(t.personHowIn(o.donorName, o.shipTo?.phone || ""))}</p>`;
      body += `<p class="note" style="margin:0">${personal ? t.waitHand(deadline(o)) : t.waitSend(deadline(o))}</p>`;
      if (late) body += `<button class="btn small" data-action="cancel" data-id="${o.id}" style="margin-top:8px">${t.cancelLate}</button>`;
    }
    if (o.status === "SENT") {
      body += `<div class="stack" style="gap:8px"><span class="note">${personal ? t.personSent : `${esc(t.sentInfo(o.trackingNumber))} · <a href="${trackUrl(o.trackingNumber)}" target="_blank" rel="noopener">${t.track}</a>`}</span>
        <div class="row"><button class="btn small primary" data-action="pickup" data-id="${o.id}">${personal ? t.confirmPerson : t.confirm}</button></div></div>`;
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
    if (o.status !== "CANCELLED") body += reportBox(o, "recipient", reports);
    return `<div class="order">${cover(o, "mini")}<div style="min-width:0"><h3>${esc(o.title)}</h3><span class="donor">${esc(t.from(o.donorName))}</span>${body}</div></div>`;
  };
  const outgoing = (o) => {
    const personal = o.delivery === "PERSONAL";
    let body = o.status === "CANCELLED" ? `<p class="warnbox" style="margin-top:10px">${t.cancelledOut}</p>` : track(o);
    if (o.status === "CREATED") {
      body += `<div class="stack" style="gap:8px">
        <span class="note">${personal ? t.personHow : t.sendHow}</span>
        ${contact(o.shipTo || {})}
        <span class="note">${personal ? t.waitHand(deadline(o)) : t.waitSend(deadline(o))}</span>
        ${personal
          ? `<div class="row"><button class="btn small primary" data-action="handover" data-id="${o.id}">${t.handedOver}</button></div>`
          : `<form class="isbn-row" data-form="sent" data-id="${o.id}"><input class="field" name="tracking" required minlength="4" maxlength="40" placeholder="${esc(t.tracking)}" aria-label="${esc(t.tracking)}"><button class="btn small primary">${t.markSent}</button></form>`}
        <button class="linkbtn note" style="align-self:start" data-action="cancel" data-id="${o.id}">${t.cancelOut}</button></div>`;
    }
    if (o.status === "SENT") body += `<span class="note">${personal ? t.personSent : `${esc(t.sentInfo(o.trackingNumber))} · <a href="${trackUrl(o.trackingNumber)}" target="_blank" rel="noopener">${t.track}</a>`}</span>`;
    if (o.status === "PICKED_UP") body += `<span class="tag good">${esc(t.deliveredOut(o.recipientName))}</span>`;
    if (o.status === "SENT" || o.status === "PICKED_UP") body += reportBox(o, "donor", reports);
    return `<div class="order">${cover(o, "mini")}<div style="min-width:0"><h3>${esc(o.title)}</h3><span class="donor">${esc(t.to(o.recipientName, o.recipientCity))}</span>${body}</div></div>`;
  };
  const draw = (key) => {
    const el = `#${key}`;
    const list = lists[key];
    const render = key === "incoming" ? incoming : outgoing;
    const empty = key === "incoming" ? t.noIncoming : t.noOutgoing;
    // nepreklesľovať zoznam, kým používateľ píše do formulára
    if ($(el).contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) return;
    $(el).innerHTML = list.length ? `<div class="list">${list.map(render).join("")}</div>` : `<div class="empty">${empty}</div>`;
  };
  const sub = (field, key) => routeSubs.push(onSnapshot(query(collection(db, "orders"), where(field, "==", S.user.uid)), (s) => {
    lists[key] = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    lists[key].forEach((o) => orderCache.set(o.id, o));
    draw(key);
  }, () => toast(T().common.error, true)));
  sub("recipientUid", "incoming");
  sub("donorUid", "outgoing");
  routeSubs.push(onSnapshot(query(collection(db, "reports"), where("reporterUid", "==", S.user.uid)), (s) => {
    reports = s.docs.map((d) => d.data());
    draw("incoming");
    draw("outgoing");
  }, () => {}));
}

/* ---------- správa (hlásenia) ---------- */

function viewAdmin() {
  const t = T().admin;
  if (!S.admin) return go("#/");
  $("#view").innerHTML = `
    <div class="section-head"><div><h1>${t.title}</h1><p class="sub">${t.sub}</p></div></div>
    <div id="reports" class="list"><p class="hint">${T().common.loading}</p></div>`;
  const people = new Map();
  const orders = new Map();
  let reports = [];
  const draw = () => {
    const te = T().ex;
    if (!reports.length) { $("#reports").innerHTML = `<div class="empty">${t.none}</div>`; return; }
    $("#reports").innerHTML = reports.map((r) => {
      const o = orders.get(r.orderId) || {};
      const donor = people.get(o.donorUid) || {};
      const rec = people.get(o.recipientUid) || {};
      const who = (u, id) => `${esc(u.name || "?")} · ${t.points(u.points ?? "?")}${u.blocked ? ` · <b style="color:var(--stamp)">${t.blocked}</b>` : ""}
        <button class="linkbtn note" data-action="adminblock" data-id="${id}" data-value="${u.blocked ? "0" : "1"}">${u.blocked ? t.unblock : t.block}</button>`;
      return `<div class="admin-card ${r.status === "OPEN" ? "open" : ""}">
        <div class="row" style="justify-content:space-between"><b>${esc(r.title)}</b><span class="tag ${r.status === "OPEN" ? "hot" : "good"}">${r.status === "OPEN" ? t.open : t.resolved}</span></div>
        <p style="margin:0"><b>${esc(te.reasons[r.reason] || r.reason)}</b> – ${esc(t.by(r.reporterName, r.role))}, ${r.createdAt ? fmtDate(r.createdAt.toDate()) : ""}</p>
        ${r.text ? `<p style="margin:0">„${esc(r.text)}“</p>` : ""}
        <dl class="kv">
          <dt>${t.status}</dt><dd>${esc(o.status || "?")}${o.delivery === "PERSONAL" ? " (osobne)" : ""}${o.trackingNumber ? ` · ${t.tracking}: ${esc(o.trackingNumber)}` : ""}</dd>
          <dt>${t.donor}</dt><dd>${o.donorUid ? who(donor, o.donorUid) : "?"}</dd>
          <dt>${t.recipient}</dt><dd>${o.recipientUid ? who(rec, o.recipientUid) : "?"}</dd>
        </dl>
        <form class="stack" data-form="resolve" data-id="${r.id}" style="gap:8px">
          <textarea class="field w" name="adminNote" maxlength="1000" placeholder="${esc(t.note)}" aria-label="${esc(t.note)}">${esc(r.adminNote || "")}</textarea>
          <div class="row">
            <button class="btn small primary" name="status" value="${r.status === "OPEN" ? "RESOLVED" : "OPEN"}">${r.status === "OPEN" ? t.resolve : t.reopen}</button>
            ${o.recipientUid ? `<button class="btn small" type="button" data-action="adminpoint" data-id="${o.recipientUid}" data-value="1">${t.plusRecipient}</button>` : ""}
            ${o.donorUid ? `<button class="btn small" type="button" data-action="adminpoint" data-id="${o.donorUid}" data-value="1">${t.plusDonor}</button>
              <button class="btn small" type="button" data-action="adminpoint" data-id="${o.donorUid}" data-value="-1">${t.minusDonor}</button>` : ""}
          </div>
        </form></div>`;
    }).join("");
  };
  const watched = new Set();
  const watchDoc = (col, id, map) => {
    const key = `${col}/${id}`;
    if (!id || watched.has(key)) return;
    watched.add(key);
    routeSubs.push(onSnapshot(ref(col, id), (s) => { map.set(id, s.data() || {}); draw(); }, () => {}));
  };
  routeSubs.push(onSnapshot(query(collection(db, "reports"), limit(300)), (s) => {
    reports = s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(b.status === "OPEN") - Number(a.status === "OPEN") || ms(b.createdAt) - ms(a.createdAt));
    reports.forEach((r) => watchDoc("orders", r.orderId, orders));
    draw();
  }, () => toast(T().common.error, true)));
  // keď prídu objednávky, sledujeme aj profily darcu a príjemcu
  const origDraw = draw;
  const tick = setInterval(() => {
    orders.forEach((o) => { watchDoc("users", o.donorUid, people); watchDoc("users", o.recipientUid, people); });
  }, 500);
  routeSubs.push(() => clearInterval(tick));
  origDraw();
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
      <div class="row"><button class="btn primary">${T().common.save}</button></div></form>
    <p class="hint">${t.yourId}: <span class="mono">${esc(S.user.uid)}</span></p></div>`;
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
    S.registering = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, String(fd.get("email")).trim(), String(fd.get("password")));
      await setDoc(ref("users", cred.user.uid), newProfile(p));
      S.profile = S.profile || { ...p, points: 0, welcomeGiven: false };
      S.ready = true;
    } finally {
      S.registering = false;
    }
    go("#/darovat");
  },
  async reset(f, fd) {
    await sendPasswordResetEmail(auth, String(fd.get("email")).trim()).catch((e) => { if (e.code !== "auth/user-not-found") throw e; });
    toast(T().auth.resetSent);
  },
  async profile(f, fd) {
    const p = profileData(fd);
    const r = ref("users", S.user.uid);
    if (S.profile || (await getDoc(r)).exists()) await updateDoc(r, p);
    else await setDoc(r, newProfile(p));
    toast(T().auth.profileSaved);
    go("#/");
  },
  // Objednávka: v jednej dávke vznikne objednávka, ponuka sa zmení na CLAIMED a príjemcovi ubudne bod.
  async claim(f, fd) {
    const delivery = fd.get("delivery") === "PERSONAL" ? "PERSONAL" : "PACKETA";
    const shipTo = {
      fullName: String(fd.get("fullName")).trim(), phone: String(fd.get("phone")).trim(),
      pickupPoint: delivery === "PACKETA" ? String(fd.get("pickupPoint") || "").trim() : "", email: S.user.email || "",
    };
    const saved = JSON.parse(store.get("dk-ship") || "{}");
    store.set("dk-ship", JSON.stringify({ ...saved, ...shipTo, pickupPoint: shipTo.pickupPoint || saved.pickupPoint || "" }));
    const listingId = location.hash.split("/")[2];
    const l = (await getDoc(ref("listings", listingId))).data();
    if (!l || l.status !== "AVAILABLE") fail(T().book.gone);
    if ((S.profile.points || 0) < 1) fail(T().book.noPoints);
    const orderId = newId("orders");
    const b = writeBatch(db);
    b.set(ref("orders", orderId), {
      listingId, copyId: l.copyId, title: l.title, author: l.author, color: l.color, cover: l.cover || null,
      condition: l.condition, genre: l.genre, language: l.language,
      donorUid: l.donorUid, donorName: l.donorName, donorCountry: l.donorCountry,
      recipientUid: S.user.uid, recipientName: S.profile.name, recipientCity: S.profile.city, recipientCountry: S.profile.country,
      delivery, shipTo, status: "CREATED", trackingNumber: null, keep: null, rating: null, createdAt: serverTimestamp(),
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
    const code = parseCode(fd.get("isbn"));
    await createBook({
      isbn: code.isbn || null, title: String(fd.get("title")).trim(), author: String(fd.get("author")).trim(),
      genre: fd.get("genre"), language: fd.get("language"), cover: String(fd.get("cover") || "") || null,
    }, String(fd.get("condition")), String(fd.get("note") || "").trim(), photo);
    await maybeWelcomePoint();
    f.reset();
    $("#cover-prev").innerHTML = "";
    $("#isbn-msg").textContent = t.ok;
    toast(t.ok);
  },
  async bulkcodes(f, fd) {
    const codes = String(fd.get("codes") || "").split(/[\s,;]+/).filter(Boolean);
    f.reset();
    await Promise.all(codes.map(addBulkCode));
  },
  // Wishlist: súkromný záznam a verejná anonymná kópia (pre počet čakateľov) v jednej dávke.
  async wish(f, fd) {
    const q = String(fd.get("q") || "").trim();
    if (!q) return;
    const id = newId("wishlist");
    const b = writeBatch(db);
    b.set(ref("wishlist", id), { uid: S.user.uid, q, qn: norm(q), createdAt: serverTimestamp() });
    b.set(ref("wants", id), { qn: norm(q), createdAt: serverTimestamp() });
    await b.commit();
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
  async report(f, fd) {
    const o = orderCache.get(f.dataset.id);
    await setDoc(ref("reports", newId("reports")), {
      orderId: o.id, title: o.title, reporterUid: S.user.uid, reporterName: S.profile.name, role: f.dataset.role,
      reason: fd.get("reason"), text: String(fd.get("text") || "").trim(), status: "OPEN", createdAt: serverTimestamp(),
    });
    toast(T().ex.reportSent);
  },
  async resolve(f, fd, submitter) {
    await updateDoc(ref("reports", f.dataset.id), {
      status: submitter?.value === "OPEN" ? "OPEN" : "RESOLVED",
      adminNote: String(fd.get("adminNote") || "").trim(), resolvedAt: serverTimestamp(),
    });
    toast(T().admin.done);
  },
};

const newProfile = (p) => ({ ...p, points: 0, welcomeGiven: false, createdAt: serverTimestamp() });

function listingData(copyId, copy, condition, note, photo, prevOrder) {
  return {
    copyId, title: copy.title, author: copy.author, genre: copy.genre, language: copy.language, color: copy.color,
    cover: copy.cover || null, search: norm(`${copy.title} ${copy.author}`).slice(0, 420), condition, note, photo,
    donorUid: S.user.uid, donorName: S.profile.name, donorCity: S.profile.city, donorCountry: S.profile.country,
    status: "AVAILABLE", orderId: null, prevOrder, createdAt: serverTimestamp(),
  };
}

// Nová kniha: exemplár a ponuka v jednej dávke.
async function createBook(book, condition, note, photo, color) {
  const copyId = newId("copies");
  const copy = {
    isbn: book.isbn, title: book.title, author: book.author, genre: book.genre, language: book.language,
    color: color || COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)], cover: book.cover || null,
    createdAt: serverTimestamp(), createdBy: S.user.uid,
  };
  const b = writeBatch(db);
  b.set(ref("copies", copyId), copy);
  b.set(ref("listings", newId("listings")), listingData(copyId, copy, condition, note, photo, null));
  await b.commit();
}

// Uvítací bod: raz za účet, keď má používateľ dve vlastné ponuky (pravidlá ich overia).
async function maybeWelcomePoint() {
  if (S.profile.welcomeGiven) return;
  const s = await getDocs(query(collection(db, "listings"), where("donorUid", "==", S.user.uid), limit(2)));
  if (s.size < 2) return;
  await updateDoc(ref("users", S.user.uid), { points: increment(1), welcomeGiven: true, welcomeListings: s.docs.map((d) => d.id) });
  S.profile.welcomeGiven = true;
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
    await forms[f.dataset.form](f, fd, e.submitter);
  } catch (err) {
    console.error(err);
    toast(err.shown ? err.message : errText(err), true);
  } finally {
    busy(f, false);
  }
});

let stopScan = null;
function closeScanner() {
  stopScan?.();
  stopScan = null;
  $("#scanner")?.remove();
}

// Otvorí fotoaparát; pri hromadnom darovaní ostane otvorený a pridáva kódy jeden po druhom.
async function openScanner(continuous) {
  const t = T().donate;
  closeScanner();
  const box = document.createElement("div");
  box.id = "scanner";
  box.className = "scanner";
  box.innerHTML = `<div class="scanner-in"><video playsinline muted></video><div class="scanner-line"></div>
    <p>${continuous ? t.bulkScanHint : t.scanHint}</p><p id="scan-last"></p>
    <button class="btn" type="button" data-action="closescan">${T().common.cancel}</button></div>`;
  document.body.appendChild(box);
  let last = "";
  const onCode = async (code) => {
    if (!continuous) {
      closeScanner();
      $("#isbn").value = code;
      fillFromCode(code);
      return;
    }
    if (code !== last) {
      last = code;
      $("#scan-last") && ($("#scan-last").textContent = t.bulkScanned(code));
      if (navigator.vibrate) navigator.vibrate(60);
      addBulkCode(code);
    }
    // čítačka sa po kóde zastaví; po chvíli ju spustíme znova pre ďalšiu knihu
    setTimeout(async () => {
      if (!$("#scanner")) return;
      try { stopScan = await startScanner($("video", box), onCode); } catch {}
    }, 1200);
  };
  try {
    stopScan = await startScanner($("video", box), onCode);
  } catch (e) {
    console.error(e);
    closeScanner();
    const msg = $("#isbn-msg");
    if (msg) msg.textContent = t.cameraErr; else toast(t.cameraErr, true);
  }
}

const actions = {
  async logout() {
    routeSubs.forEach((u) => u());
    routeSubs = [];
    await signOut(auth);
    go("#/");
  },
  lang(el) { store.set("dk-lang", el.dataset.lang); route(); },
  async isbn() { await fillFromCode($("#isbn").value); },
  async scan() { await openScanner(false); },
  async bulkscan() { await openScanner(true); },
  closescan() { closeScanner(); },
  delivery(el) { viewBook.setDelivery?.(el.value); },
  bulkremove(el) { bulkQueue.splice(Number(el.dataset.id), 1); drawBulk(); },
  async bulksave(el) {
    const t = T().donate;
    if (bulkQueue.some((b) => !b.title.trim() || !b.author.trim())) fail(t.bulkMissing);
    el.textContent = T().donate.submitting;
    let done = 0;
    for (const b of [...bulkQueue]) {
      await createBook({ isbn: b.isbn, title: b.title.trim(), author: b.author.trim(), genre: b.genre, language: b.language, cover: b.cover },
        b.condition, "", null, b.color);
      bulkQueue.splice(bulkQueue.indexOf(b), 1);
      done++;
      drawBulk();
    }
    await maybeWelcomePoint();
    toast(t.bulkSaved(done));
  },
  async withdraw(el) { await updateDoc(ref("listings", el.dataset.id), { status: "WITHDRAWN" }); },
  async unwish(el) {
    const b = writeBatch(db);
    b.delete(ref("wishlist", el.dataset.id));
    b.delete(ref("wants", el.dataset.id));
    await b.commit();
  },
  async handover(el) {
    await updateDoc(ref("orders", el.dataset.id), { status: "SENT", trackingNumber: null, sentAt: serverTimestamp() });
  },
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
  async adminpoint(el) {
    const u = (await getDoc(ref("users", el.dataset.id))).data();
    await updateDoc(ref("users", el.dataset.id), { points: Math.max(0, (u.points || 0) + Number(el.dataset.value)) });
    toast(T().admin.done);
  },
  async adminblock(el) {
    await updateDoc(ref("users", el.dataset.id), { blocked: el.dataset.value === "1" });
    toast(T().admin.done);
  },
};

document.addEventListener("click", async (e) => {
  const chip = e.target.closest("[data-filter]");
  if (chip) { catalogFilter[chip.dataset.filter] = chip.dataset.value; route(); return; }
  const el = e.target.closest("[data-action], [data-lang]");
  if (!el || el.matches("input[type=radio]")) return;
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

document.addEventListener("change", (e) => {
  if (e.target.matches("input[data-action=delivery]")) actions.delivery(e.target);
  // úpravy v zozname hromadného darovania
  const b = e.target.closest("[data-bulk]");
  if (b) bulkQueue[Number(b.dataset.bulk)][b.dataset.key] = b.value;
});
document.addEventListener("input", (e) => {
  const b = e.target.closest("input[data-bulk]");
  if (b) bulkQueue[Number(b.dataset.bulk)][b.dataset.key] = b.value;
});

// Enter v políčku ISBN načíta údaje namiesto odoslania celého formulára.
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "isbn") { e.preventDefault(); fillFromCode(e.target.value); }
  if (e.key === "Escape") closeScanner();
});

renderHeader();
if (!configured) { S.ready = true; route(); }
