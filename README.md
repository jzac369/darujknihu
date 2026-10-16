# DarujKnihu.sk

Výmena kníh zadarmo za body pre Slovensko a Česko. Za každú darovanú knihu, ktorú si nový čitateľ vyzdvihne, dostane darca 1 bod. Za 1 bod si môže vziať ktorúkoľvek knihu z katalógu. Získanú knihu si môže nechať, alebo ju po prečítaní poslať ďalej.

Web je statický (GitHub Pages) a dáta sú vo Firebase na **bezplatnom pláne Spark**: Authentication (e-mail a heslo) a Firestore. Cloud Functions ani Storage sa nepoužívajú, lebo vyžadujú platený plán Blaze.

- Web: https://jzac369.github.io/darujknihu/
- Firebase projekt: `darujknihu-c44b7` (účet Jaroslav)
- Prototyp: https://jzac369.github.io/darujknihu/prototyp/

## Štruktúra

```
public/                     statický web nasadzovaný na GitHub Pages
  index.html                jediná stránka, obrazovky prepína app.js (#/kniha/…, #/vymeny, …)
  assets/app.js             prihlásenie, katalóg, darovanie, wishlist, výmeny
  assets/i18n.js            texty po slovensky a česky
  assets/firebase-config.js konfigurácia Firebase projektu (nie je tajná)
  prototyp/                 pôvodný klikateľný prototyp
firestore.rules             pravidlá, ktoré strážia body a každý krok výmeny
.github/workflows/deploy.yml  automatické nasadenie public/ na GitHub Pages
```

## Ako to funguje bez servera

Každý krok výmeny zapíše prehliadač ako jednu dávku (batch). Pravidlá vo `firestore.rules` ju pustia len vtedy, keď sedí celá:

| Krok | Čo sa zapíše naraz | Čo pravidlá overia |
| --- | --- | --- |
| Registrácia | profil s 0 bodmi | nikto si nezačne s bodmi |
| Uvítací bod | +1 bod, `welcomeGiven` | raz za účet, ak existujú 2 vlastné ponuky |
| Objednávka | objednávka, ponuka → CLAIMED, príjemca −1 bod | ponuka bola voľná, príjemca mal bod |
| Odoslanie | stav SENT, číslo zásielky | robí to darca tejto objednávky |
| Vyzdvihnutie | stav PICKED_UP, ponuka → DELIVERED, darca +1 bod, záznam v pase | len príjemca a len raz (SENT → PICKED_UP) |
| Zrušenie | stav CANCELLED, ponuka stiahnutá, príjemca +1 bod | darca kedykoľvek pred odoslaním, príjemca až po 5 dňoch |
| Poslať ďalej | nová ponuka toho istého exempláru, objednávka → PASS | len príjemca vyzdvihnutej knihy, len raz |

Kontakt na doručenie (meno, telefón, výdajné miesto) vidí iba darca a príjemca danej objednávky. Fotka knihy sa zmenší v prehliadači a uloží priamo do ponuky.

## ISBN, EAN a skenovanie (`public/assets/isbn.js`)

- Čiarový kód knihy je EAN-13 začínajúci 978/979 – to isté číslo ako ISBN-13. Iný EAN nie je kniha a údaje sa vyplnia ručne.
- 10-miestne ISBN sa overí a prevedie na ISBN-13.
- Údaje sa hľadajú postupne v **knihovny.cz** (súhrnný katalóg českých knižníc, dobre pokrýva aj slovenské vydania), **Open Library** a **Google Books**. Všetky sú bezplatné a bez kľúča.
- Slovenská národná knižnica ani Národní knihovna ČR verejné rozhranie dostupné z prehliadača nemajú.
- Skenovanie fotoaparátom: v Chrome na Androide natívny `BarcodeDetector`, inde knižnica ZXing (`@zxing/browser` z jsDelivr). Funguje len cez HTTPS.

Doprava je v ručnom režime: darca pošle knihu sám cez Packetu (aplikácia alebo packeta.sk / zasilkovna.cz) a zadá číslo zásielky.

## Nasadenie

- **Web:** každý push na `main` nasadí priečinok `public/` cez GitHub Actions.
- **Pravidlá:** po zmene `firestore.rules`
  ```bash
  npx firebase-tools login
  npx firebase-tools deploy --only firestore --project darujknihu-c44b7
  ```

## Lokálne testovanie

Emulátory Firebase potrebujú Javu 11 alebo novšiu.

```bash
npx firebase-tools emulators:start --project demo-darujknihu
```

V druhom okne spustite `python -m http.server 5500 --directory public` a otvorte http://localhost:5500. Na localhoste sa web sám pripojí na emulátory.

## Obmedzenia bezplatnej verzie

- Žiadne e-mailové upozornenia; čo treba urobiť, ukazuje značka pri „Moje výmeny“.
- Wishlist zvýrazňuje zhody v katalógu, ale knihu nerezervuje.
- Neodoslané objednávky sa nerušia samy; príjemca ich môže zrušiť po 5 dňoch.
- Limity plánu Spark: 50 000 čítaní a 20 000 zápisov denne, 1 GB dát.
