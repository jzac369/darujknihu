// ISBN a EAN: overenie čísla, vyhľadanie údajov o knihe a skenovanie čiarového kódu.
//
// Čiarový kód knihy je EAN-13 a pri knihách začína 978 alebo 979 – je to to isté číslo ako ISBN-13.
// Staršie 10-miestne ISBN prevedieme na ISBN-13, lebo katalógy hľadajú spoľahlivejšie podľa neho.

const digits = (s) => String(s || "").replace(/[^0-9Xx]/g, "").toUpperCase();

function validIsbn13(c) {
  if (!/^\d{13}$/.test(c)) return false;
  const sum = [...c.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(c[12]);
}

function validIsbn10(c) {
  if (!/^\d{9}[\dX]$/.test(c)) return false;
  const sum = [...c].reduce((s, d, i) => s + (d === "X" ? 10 : Number(d)) * (10 - i), 0);
  return sum % 11 === 0;
}

function isbn10to13(c) {
  const core = "978" + c.slice(0, 9);
  const sum = [...core].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return core + ((10 - (sum % 10)) % 10);
}

// Vráti { isbn } pre knihu, { ean } pre EAN, ktorý nie je kniha, alebo { invalid: true }.
export function parseCode(raw) {
  const c = digits(raw);
  if (c.length === 10 && validIsbn10(c)) return { isbn: isbn10to13(c) };
  if (c.length === 13 && validIsbn13(c)) return /^97[89]/.test(c) ? { isbn: c } : { ean: c };
  return { invalid: true };
}

// Meno autora z knižničného katalógu: "Jirotka, Zdeněk, 1911-2003" alebo "Zdeněk Jirotka, 1911-2003".
function cleanAuthor(name) {
  let n = name.replace(/,?\s*\d{3,4}\s*-\s*(\d{3,4})?\s*$/, "").trim();
  const m = n.match(/^([^,]+),\s*([^,]+)$/);
  if (m) n = `${m[2]} ${m[1]}`;
  return n;
}
const cleanTitle = (t) => t.replace(/[\s/:;,.]+$/, "").trim();

const SOURCES = [
  // Súhrnný katalóg českých knižníc – najlepšie pokrytie slovenských a českých kníh.
  async (isbn) => {
    const u = `https://www.knihovny.cz/api/v1/search?lookfor=${isbn}&type=ISN&limit=1&field[]=title&field[]=authors`;
    const r = (await (await fetch(u)).json()).records?.[0];
    if (!r?.title) return null;
    const authors = Object.keys(r.authors?.primary || {}).map(cleanAuthor);
    return { title: cleanTitle(r.title), author: authors.join(", ") };
  },
  async (isbn) => {
    const j = await (await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`)).json();
    const b = j[`ISBN:${isbn}`];
    return b?.title ? { title: b.title, author: (b.authors || []).map((a) => a.name).join(", ") } : null;
  },
  async (isbn) => {
    const j = await (await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`)).json();
    const v = j.items?.[0]?.volumeInfo;
    return v?.title ? { title: v.title, author: (v.authors || []).join(", ") } : null;
  },
];

export async function lookupIsbn(isbn) {
  let hit = null;
  for (const source of SOURCES) {
    try {
      hit = await source(isbn);
      if (hit) break;
    } catch {}
  }
  if (!hit) return null;
  return { isbn, ...hit, cover: await findCover(isbn) };
}

/* ---------- obálky ---------- */

// Overí, že sa obrázok naozaj načíta (Open Library pri neznámom ISBN vráti chybu, Google malý zástupný obrázok).
const imageOk = (url) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve(img.naturalWidth > 40 && img.naturalHeight > 60);
  img.onerror = () => resolve(false);
  img.src = url;
  setTimeout(() => resolve(false), 6000);
});

export async function findCover(isbn) {
  try {
    const j = await (await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`)).json();
    const links = j.items?.[0]?.volumeInfo?.imageLinks;
    const url = (links?.thumbnail || links?.smallThumbnail || "").replace(/^http:/, "https:").replace("&edge=curl", "");
    if (url && (await imageOk(url))) return url;
  } catch {}
  const ol = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
  if (await imageOk(ol)) return ol;
  return null;
}

/* ---------- skenovanie fotoaparátom ---------- */

const ZXING = "https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.1/+esm";

// Otvorí fotoaparát vo videu a zavolá onCode s prvým prečítaným EAN/ISBN. Vráti funkciu na zastavenie.
export async function startScanner(video, onCode) {
  let stopped = false;
  let stopFn = () => {};
  const finish = (code) => {
    if (stopped) return;
    stopped = true;
    stopFn();
    onCode(code);
  };

  // Natívne rozpoznávanie (Chrome na Androide); inak knižnica ZXing.
  if ("BarcodeDetector" in window) {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (formats.includes("ean_13")) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.srcObject = stream;
      await video.play();
      const detector = new window.BarcodeDetector({ formats: ["ean_13", "upc_a"] });
      stopFn = () => stream.getTracks().forEach((t) => t.stop());
      const tick = async () => {
        if (stopped) return;
        try {
          const found = await detector.detect(video);
          if (found[0]?.rawValue) return finish(found[0].rawValue);
        } catch {}
        setTimeout(tick, 150);
      };
      tick();
      return () => { stopped = true; stopFn(); };
    }
  }

  const { BrowserMultiFormatReader } = await import(ZXING);
  const reader = new BrowserMultiFormatReader();
  const controls = await reader.decodeFromConstraints(
    { video: { facingMode: "environment" }, audio: false },
    video,
    (result) => { if (result) finish(result.getText()); },
  );
  stopFn = () => controls.stop();
  return () => { stopped = true; stopFn(); };
}
