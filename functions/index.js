// Cloud Functions pre DarujKnihu.sk.
//
// Všetko, čo mení body, ponuky, objednávky alebo pas knihy, beží tu na serveri,
// aby si nikto nemohol body pripísať z prehliadača. Pravidlá výmeny:
//  - bod darca dostane až vtedy, keď príjemca potvrdí, že si knihu vyzdvihol,
//  - uvítací bod raz za účet po prvých dvoch ponukách,
//  - objednávku, ktorú darca neodošle do 5 dní, môže príjemca zrušiť (a po 7 dňoch sa zruší sama),
//  - kniha z wishlistu sa prvému čakateľovi 24 hodín drží.
//
// Doprava je zatiaľ v ručnom režime: darca pošle knihu sám cez Packetu a zadá číslo zásielky.

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const C = require("./constants");

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

/* ---------- pomocné ---------- */

const fail = (code, msg) => {
  throw new HttpsError(code, msg);
};
const uidOf = (req) => req.auth?.uid || fail("unauthenticated", "Prihláste sa.");
const str = (v, min, max, name) => {
  if (typeof v !== "string") fail("invalid-argument", `Chýba ${name}.`);
  const s = v.trim();
  if (s.length < min || s.length > max) fail("invalid-argument", `Neplatné pole ${name}.`);
  return s;
};
const oneOf = (v, list, name) => (list.includes(v) ? v : fail("invalid-argument", `Neplatné pole ${name}.`));
const norm = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const now = () => Timestamp.now();
const DAY = 86400e3;

// Upozornenie ukladáme ako typ + parametre; text vyskladá prehliadač v jazyku čitateľa.
function notify(tx, uid, type, params = {}, href = null) {
  tx.set(db.collection("notifications").doc(), { uid, type, params, href, read: false, createdAt: now() });
}

function addPoints(tx, uid, delta, reason, orderId = null) {
  tx.set(db.collection("pointTx").doc(), { uid, delta, reason, orderId, createdAt: now() });
  tx.set(db.collection("users").doc(uid), { points: FieldValue.increment(delta) }, { merge: true });
}

async function profile(tx, uid) {
  const snap = await tx.get(db.collection("users").doc(uid));
  if (!snap.exists) fail("failed-precondition", "Najprv si dokončite profil.");
  return snap.data();
}

/* ---------- ponuky ---------- */

// Nová ponuka. copyId je vyplnené, keď čitateľ posiela ďalej knihu, ktorú dostal.
async function createListingTx(uid, input, copyId = null) {
  return db.runTransaction(async (tx) => {
    const me = await profile(tx, uid);
    const wishes = await tx.get(db.collection("wishlist"));
    const myListings = await tx.get(db.collection("listings").where("donorUid", "==", uid).limit(3));
    let copy;
    let copyRef;
    if (copyId) {
      copyRef = db.collection("copies").doc(copyId);
      const cs = await tx.get(copyRef);
      if (!cs.exists) fail("not-found", "Kniha neexistuje.");
      copy = cs.data();
    } else {
      copyRef = db.collection("copies").doc();
      copy = {
        isbn: input.isbn,
        title: input.title,
        author: input.author,
        genre: input.genre,
        language: input.language,
        color: C.COVER_COLORS[Math.floor(Math.random() * C.COVER_COLORS.length)],
        createdAt: now(),
      };
      tx.set(copyRef, copy);
    }

    const listingRef = db.collection("listings").doc();
    const listing = {
      copyId: copyRef.id,
      title: copy.title,
      author: copy.author,
      genre: copy.genre,
      language: copy.language,
      color: copy.color,
      search: norm(`${copy.title} ${copy.author}`),
      condition: input.condition,
      note: input.note || "",
      photoUrl: input.photoUrl || null,
      donorUid: uid,
      donorName: me.name,
      donorCity: me.city,
      donorCountry: me.country,
      status: "AVAILABLE",
      reservedFor: null,
      reservedUntil: null,
      createdAt: now(),
    };

    // Wishlist: prvý čakateľ dostane 24 h rezerváciu, ostatní len upozornenie.
    const hits = wishes.docs
      .map((d) => d.data())
      .filter((w) => w.uid !== uid && w.qn && listing.search.includes(w.qn))
      .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
    const seen = new Set();
    for (const w of hits) {
      if (seen.has(w.uid)) continue;
      if (seen.size === 0) {
        listing.reservedFor = w.uid;
        listing.reservedUntil = Timestamp.fromMillis(Date.now() + C.RESERVATION_HOURS * 3600e3);
        notify(tx, w.uid, "wishReserved", { title: copy.title, hours: C.RESERVATION_HOURS }, `#/kniha/${listingRef.id}`);
      } else {
        notify(tx, w.uid, "wishMatch", { title: copy.title }, `#/kniha/${listingRef.id}`);
      }
      seen.add(w.uid);
    }
    tx.set(listingRef, listing);

    // Uvítací bod pri druhej ponuke (myListings ešte neobsahuje túto).
    if (!me.welcomePoint && myListings.size + 1 >= 2) {
      tx.set(db.collection("users").doc(uid), { welcomePoint: true }, { merge: true });
      addPoints(tx, uid, 1, "WELCOME");
      notify(tx, uid, "welcomePoint", {}, "#/");
    }
    return { listingId: listingRef.id };
  });
}

exports.createListing = onCall(async (req) => {
  const uid = uidOf(req);
  const d = req.data || {};
  const photoUrl = d.photoUrl ? str(d.photoUrl, 10, 1000, "fotka") : null;
  if (photoUrl && !(photoUrl.startsWith("https://firebasestorage.googleapis.com/") || photoUrl.startsWith("http://127.0.0.1"))) {
    fail("invalid-argument", "Neplatná fotka.");
  }
  if (photoUrl && !photoUrl.includes(encodeURIComponent(`listings/${uid}/`))) fail("permission-denied", "Neplatná fotka.");
  const input = {
    isbn: d.isbn ? String(d.isbn).replace(/[^0-9Xx]/g, "").toUpperCase().slice(0, 13) : null,
    title: str(d.title, 1, 200, "názov"),
    author: str(d.author, 1, 200, "autor"),
    genre: oneOf(d.genre, C.GENRES, "žáner"),
    language: oneOf(d.language, C.LANGUAGES, "jazyk"),
    condition: oneOf(d.condition, C.CONDITIONS, "stav"),
    note: d.note ? str(d.note, 0, 300, "poznámka") : "",
    photoUrl,
  };
  return createListingTx(uid, input);
});

exports.withdrawListing = onCall(async (req) => {
  const uid = uidOf(req);
  const ref = db.collection("listings").doc(str(req.data?.listingId, 1, 64, "ponuka"));
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().donorUid !== uid) fail("not-found", "Ponuka neexistuje.");
    if (s.data().status !== "AVAILABLE") fail("failed-precondition", "Knihu si už niekto vzal.");
    tx.update(ref, { status: "WITHDRAWN" });
  });
  return { ok: true };
});

/* ---------- objednávka ---------- */

exports.claimListing = onCall(async (req) => {
  const uid = uidOf(req);
  const d = req.data || {};
  const listingRef = db.collection("listings").doc(str(d.listingId, 1, 64, "ponuka"));
  const fullName = str(d.fullName, 3, 80, "meno a priezvisko");
  const phone = str(d.phone, 9, 20, "telefón");
  const pickupPoint = str(d.pickupPoint, 3, 200, "výdajné miesto");
  const email = req.auth.token.email || "";

  return db.runTransaction(async (tx) => {
    const me = await profile(tx, uid);
    const ls = await tx.get(listingRef);
    if (!ls.exists) fail("not-found", "Kniha neexistuje.");
    const l = ls.data();
    if (l.status !== "AVAILABLE") fail("failed-precondition", "Túto knihu si už medzitým niekto vzal.");
    if (l.donorUid === uid) fail("failed-precondition", "Vlastnú knihu si vziať nemôžete.");
    if (l.reservedFor && l.reservedFor !== uid && l.reservedUntil?.toMillis() > Date.now()) {
      fail("failed-precondition", "Kniha je teraz rezervovaná pre čitateľa, ktorý ju mal na wishliste.");
    }
    if ((me.points || 0) < 1) fail("failed-precondition", "Nemáte žiadny bod. Najprv darujte knihu.");

    const orderRef = db.collection("orders").doc();
    tx.set(orderRef, {
      listingId: listingRef.id,
      copyId: l.copyId,
      title: l.title,
      author: l.author,
      color: l.color,
      condition: l.condition,
      donorUid: l.donorUid,
      donorName: l.donorName,
      donorCountry: l.donorCountry,
      recipientUid: uid,
      recipientName: me.name,
      recipientCity: me.city,
      recipientCountry: me.country,
      // Kontakt na doručenie vidí len darca tejto objednávky.
      shipTo: { fullName, phone, email, pickupPoint },
      status: "CREATED",
      trackingNumber: null,
      keep: null,
      rating: null,
      createdAt: now(),
      sentAt: null,
      pickedUpAt: null,
    });
    addPoints(tx, uid, -1, "CLAIM", orderRef.id);
    tx.update(listingRef, { status: "CLAIMED", reservedFor: null, reservedUntil: null });
    notify(tx, l.donorUid, "claimed", { title: l.title, days: C.SEND_DEADLINE_DAYS }, "#/vymeny");
    return { orderId: orderRef.id };
  });
});

async function withOrder(uid, orderId, fn) {
  const ref = db.collection("orders").doc(str(orderId, 1, 64, "objednávka"));
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) fail("not-found", "Objednávka neexistuje.");
    const o = s.data();
    if (o.donorUid !== uid && o.recipientUid !== uid) fail("not-found", "Objednávka neexistuje.");
    return fn(tx, ref, o);
  });
}

exports.markSent = onCall(async (req) => {
  const uid = uidOf(req);
  const tracking = str(req.data?.trackingNumber, 4, 40, "číslo zásielky").replace(/\s+/g, "");
  return withOrder(uid, req.data?.orderId, async (tx, ref, o) => {
    if (o.donorUid !== uid) fail("permission-denied", "Odoslať môže len darca.");
    if (o.status !== "CREATED") fail("failed-precondition", "Objednávka už bola odoslaná alebo zrušená.");
    tx.update(ref, { status: "SENT", trackingNumber: tracking, sentAt: now() });
    notify(tx, o.recipientUid, "sent", { title: o.title, tracking }, "#/vymeny");
    return { ok: true };
  });
});

exports.confirmPickup = onCall(async (req) => {
  const uid = uidOf(req);
  return withOrder(uid, req.data?.orderId, async (tx, ref, o) => {
    if (o.recipientUid !== uid) fail("permission-denied", "Vyzdvihnutie potvrdzuje príjemca.");
    if (o.status !== "SENT") fail("failed-precondition", "Kniha ešte nebola odoslaná.");
    const recipient = await profile(tx, uid);
    const donorRef = db.collection("users").doc(o.donorUid);
    tx.update(ref, { status: "PICKED_UP", pickedUpAt: now() });
    tx.update(db.collection("listings").doc(o.listingId), { status: "DELIVERED" });
    addPoints(tx, o.donorUid, 1, "DELIVERED", ref.id);
    tx.set(donorRef, { sentCount: FieldValue.increment(1) }, { merge: true });
    tx.set(db.collection("copies").doc(o.copyId).collection("passport").doc(), {
      uid,
      name: recipient.name,
      city: recipient.city,
      country: recipient.country,
      note: "",
      createdAt: now(),
    });
    notify(tx, o.donorUid, "deliveredDonor", { title: o.title }, "#/vymeny");
    notify(tx, uid, "deliveredRecipient", { title: o.title }, "#/vymeny");
    return { ok: true };
  });
});

function cancelTx(tx, ref, o, by) {
  tx.update(ref, { status: "CANCELLED", cancelledBy: by, cancelledAt: now() });
  tx.update(db.collection("listings").doc(o.listingId), { status: "WITHDRAWN" });
  addPoints(tx, o.recipientUid, 1, "REFUND", ref.id);
  notify(tx, o.recipientUid, "cancelledRecipient", { title: o.title }, "#/vymeny");
  if (by !== "donor") notify(tx, o.donorUid, "cancelledDonor", { title: o.title }, "#/vymeny");
}

// Darca môže zrušiť kedykoľvek pred odoslaním, príjemca až po uplynutí lehoty na odoslanie.
exports.cancelOrder = onCall(async (req) => {
  const uid = uidOf(req);
  return withOrder(uid, req.data?.orderId, async (tx, ref, o) => {
    if (o.status !== "CREATED") fail("failed-precondition", "Odoslanú objednávku už zrušiť nemožno.");
    const late = Date.now() - o.createdAt.toMillis() > C.SEND_DEADLINE_DAYS * DAY;
    if (o.recipientUid === uid && !late) fail("failed-precondition", `Darca má na odoslanie ${C.SEND_DEADLINE_DAYS} dní.`);
    cancelTx(tx, ref, o, o.donorUid === uid ? "donor" : "recipient");
    return { ok: true };
  });
});

exports.expireStaleOrders = onSchedule({ schedule: "every day 03:00", timeZone: "Europe/Bratislava" }, async () => {
  const limit = Timestamp.fromMillis(Date.now() - C.AUTO_CANCEL_DAYS * DAY);
  const stale = await db.collection("orders").where("status", "==", "CREATED").where("createdAt", "<", limit).get();
  for (const doc of stale.docs) {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(doc.ref);
      if (s.data().status === "CREATED") cancelTx(tx, doc.ref, s.data(), "system");
    });
  }
});

/* ---------- po vyzdvihnutí ---------- */

exports.setKeep = onCall(async (req) => {
  const uid = uidOf(req);
  const choice = oneOf(req.data?.choice, ["KEEP", "PASS"], "voľba");
  const o = await withOrder(uid, req.data?.orderId, async (tx, ref, o) => {
    if (o.recipientUid !== uid || o.status !== "PICKED_UP") fail("failed-precondition", "Objednávka nie je vyzdvihnutá.");
    if (o.keep === "PASS") fail("failed-precondition", "Kniha už je znova v katalógu.");
    tx.update(ref, { keep: choice });
    return o;
  });
  if (choice === "PASS") {
    const condition = req.data?.condition ? oneOf(req.data.condition, C.CONDITIONS, "stav") : o.condition;
    await createListingTx(uid, { condition, note: "" }, o.copyId);
  }
  return { ok: true };
});

exports.rateOrder = onCall(async (req) => {
  const uid = uidOf(req);
  const rating = Number(req.data?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail("invalid-argument", "Hodnotenie je 1 až 5.");
  return withOrder(uid, req.data?.orderId, async (tx, ref, o) => {
    if (o.recipientUid !== uid || o.status !== "PICKED_UP") fail("failed-precondition", "Hodnotiť možno až po vyzdvihnutí.");
    if (o.rating) fail("failed-precondition", "Už ste hodnotili.");
    tx.update(ref, { rating });
    tx.set(
      db.collection("users").doc(o.donorUid),
      { ratingSum: FieldValue.increment(rating), ratingCount: FieldValue.increment(1) },
      { merge: true },
    );
    return { ok: true };
  });
});

exports.addPassportNote = onCall(async (req) => {
  const uid = uidOf(req);
  const note = str(req.data?.note, 1, 200, "odkaz");
  return withOrder(uid, req.data?.orderId, async (tx, ref, o) => {
    if (o.recipientUid !== uid || o.status !== "PICKED_UP") fail("failed-precondition", "Odkaz môže pridať len čitateľ.");
    const q = await tx.get(
      db.collection("copies").doc(o.copyId).collection("passport").where("uid", "==", uid).limit(1),
    );
    if (q.empty) fail("not-found", "Záznam v pase knihy sa nenašiel.");
    tx.update(q.docs[0].ref, { note });
    return { ok: true };
  });
});
