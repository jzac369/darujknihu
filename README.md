# DarujKnihu.sk

Výmena kníh zadarmo za body pre Slovensko a Česko. Za každú darovanú knihu, ktorú si nový čitateľ vyzdvihne, dostane darca 1 bod. Za 1 bod si môže vziať ktorúkoľvek knihu z katalógu. Získanú knihu si môže nechať, alebo ju po prečítaní poslať ďalej.

Front-end je statický (GitHub Pages), dáta a logika bežia na Firebase (Auth, Firestore, Cloud Functions, Storage) – rovnako ako pri projekte mudro-a-bezpecne-online.

## Štruktúra

```
public/                  statický web nasadzovaný na GitHub Pages
  index.html             jediná stránka, obrazovky prepína app.js (#/kniha/…, #/vymeny, …)
  assets/app.js          prihlásenie, katalóg, darovanie, wishlist, výmeny, upozornenia
  assets/i18n.js         texty po slovensky a česky
  assets/firebase-config.js  konfigurácia Firebase projektu (treba doplniť)
  prototyp/              pôvodný klikateľný prototyp
functions/               Cloud Functions: body, ponuky, objednávky, pas knihy
firestore.rules          kto smie čo čítať a zapisovať
storage.rules            nahrávanie fotiek kníh (len do vlastného priečinka, do 3 MB)
.github/workflows/deploy.yml  automatické nasadenie public/ na GitHub Pages
```

## Ako funguje výmena (ručný režim dopravy)

1. Darca ponúkne knihu. Po prvých dvoch ponukách dostane uvítací bod.
2. Čitateľ si knihu vezme za 1 bod a zadá meno, telefón a výdajné miesto Packety. Tieto údaje vidí iba darca.
3. Darca pošle knihu sám cez Packetu (aplikácia alebo packeta.sk / zasilkovna.cz) a zadá do portálu číslo zásielky.
4. Čitateľ potvrdí vyzdvihnutie, darca dostane 1 bod a čitateľ sa zapíše do pasu knihy.
5. Čitateľ si knihu nechá, alebo ju jedným klikom pošle ďalej (vznikne nová ponuka s tým istým pasom).

Ak darca neodošle knihu do 5 dní, čitateľ môže objednávku zrušiť a dostane bod späť. Po 7 dňoch sa zruší sama (naplánovaná funkcia `expireStaleOrders`).

Body mení iba server. Prehliadač smie zapisovať len vlastný profil, wishlist a označenie upozornení ako prečítaných.

## Prvé nasadenie

1. **Firebase projekt:** v [Firebase Console](https://console.firebase.google.com) vytvorte projekt `darujknihu` (ak je názov obsadený, zvoľte iný a zmeňte ho v `.firebaserc`).
2. V projekte zapnite:
   - **Authentication → Sign-in method → Email/Password**
   - **Firestore Database** (umiestnenie `eur3` alebo `europe-west1`)
   - **Storage**
   - plán **Blaze** (Cloud Functions ho vyžadujú; pri malej návštevnosti je to zvyčajne 0 €)
3. **Webová aplikácia:** Project settings → Your apps → pridať Web app → hodnoty skopírovať do `public/assets/firebase-config.js`.
4. **Authentication → Settings → Authorized domains:** pridať `jzac369.github.io`.
5. **Nasadiť backend** (v priečinku projektu):
   ```bash
   npx firebase-tools login
   npx firebase-tools deploy --only functions,firestore,storage
   ```
6. **GitHub Pages:** v repozitári Settings → Pages → Source: **GitHub Actions**. Každý push na `main` web nasadí.

Web potom beží na https://jzac369.github.io/darujknihu/.

## Lokálne testovanie

Emulátory Firebase potrebujú Javu 11 alebo novšiu.

```bash
cd functions && npm install && cd ..
npx firebase-tools emulators:start --project demo-darujknihu
```

V druhom okne spustite `python -m http.server 5500 --directory public` a otvorte http://localhost:5500. Na localhoste sa web sám pripojí na emulátory.

## Čo ďalej

- Zmluva s Packetou: automatické zakladanie zásielok a poštovné, ktoré zaplatí príjemca namiesto darcu.
- Firebase App Check proti zneužitiu (ako v dealboard-sk).
- Overenie e-mailu pri registrácii, nahlasovanie problémov s knihou.
