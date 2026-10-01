# Exit Pass

**What if checkout were finished before you got to the front of the store?**

Exit Pass is a working prototype of grocery checkout built from scratch around the phone every shopper already carries. It's a simulation, not a Vons integration: POS, payments, cart sensors and store traffic are all simulated.

## The idea

Scan & Go apps still end at a register. A shopper scans everything, then waits in line so someone can audit it. Exit Pass takes the line out entirely:

1. **Checkout happens while you shop.** Every item you scan goes into a running, tax-included total. A smart-cart weight sensor (simulated) checks that what's in the cart matches what was scanned. If it doesn't match, the app asks you about it while you're still in the aisle, not at the exit.
2. **Paying takes one tap, wherever you are.** Tap **Done** and you've paid before you reach the front.
3. **The store issues a pass based on that trip:**
   - **Green: walk out.** No line and no scan.
   - **Amber: a 10-second check.** The associate doesn't re-scan 40 items. The system names the 1–3 that matter: alcohol needing an ID check, a high-value item, an unmatched weight, or a random audit.
4. **The front end sees what's coming.** Every cart in the store shows up live, so the lead can staff the front based on predicted arrivals instead of reacting once the lines are already long.

The missing idea is **targeted verification instead of exhaustive verification.** The register stops being a 5-minute scanning station and becomes a 10-second glance, and most trips skip it entirely.

## Screens

| Route | Who | What |
|---|---|---|
| `/` | Shopper (phone) | Sign in → scan → live total with member savings → Done → Exit Pass (live QR) → receipt. Trip history and account tabs. |
| `/#/pos` | Cashier | **Register lane** modeled on the store's Toshiba TCx SKY + Magellan + keypad, running the Exit Pass extension. Recall a paid basket by scanning the phone's QR or keying the recall number, do the checks, add missed items (charged to the shopper's card), then close. Regular sales still work. `/#/pos/2` is Lane 2. |
| `/#/sco` | Shopper at a kiosk | **Self-checkout**: hold up the pass and you're done. ID checks call the attendant. |
| `/#/associate` | Associate handheld | Verification queue showing only the items to check |
| `/#/store` | Front-end lead | Store radar, KPIs, arrival forecast, staffing recommendation, live feed of lane events |
| `/#/demo` | Presenting on a laptop | Phone next to a switchable Store / Register / Self-checkout / Associate panel |

The POS integration design, mapped to the hardware at the lane, is in **[docs/POS_INTEGRATION.md](docs/POS_INTEGRATION.md)**.

## Run it

```bash
npm start          # zero dependencies, Node 18+
```

Open `http://localhost:5173/#/demo`. Local sync between devices works out of the box.

### How scanning works
- **Decoding:** Android Chrome uses the phone's built-in barcode detector. iPhone and other browsers use ZXing compiled to WebAssembly, which is bundled in `public/vendor` so it doesn't depend on a CDN. Reads EAN-13, UPC-A, UPC-E and EAN-8. A code is accepted only if its check digit is valid and the same code appears on two frames in a row, which rules out misreads. There's a flashlight button on phones that support it.
- **Identification:** `api/lookup.js` (a Vercel function, also served by `npm start`) searches Open Food Facts, UPCitemdb, and Open Products, Beauty and Pet Food Facts in parallel, and returns the name, brand, size and photo. If nothing matches, the shopper types a name. On hosting without functions, the app queries Open Food Facts directly.
- **Prices are simulated** (stable per UPC). Real prices would come from the store's price file.

## Deploy on Vercel

1. **Add New → Project → Import** `mosrvs2025/checkout`, keep the defaults, and click **Deploy**. `vercel.json` serves `public/`, and `api/` becomes serverless functions.
2. **For cross-device sync** (phone + register + store screen on different devices): in the Vercel project go to **Storage → Create → Upstash for Redis** (free tier), connect it to the project, and redeploy. The sync function finds the `KV_REST_API_*` / `UPSTASH_REDIS_REST_*` variables automatically. The store dashboard header shows `Synced across devices (upstash)` when it's working.
   - Without Upstash, sync falls back to memory inside one serverless instance. That often works for a quick demo but isn't reliable. Tabs on the same device always sync.
3. Open the `https://….vercel.app` link on your phone and use **Add to Home Screen** for a full-screen app. HTTPS means camera scanning works.

## Demo script (2 minutes, two devices)

1. **Phone:** sign in (the code fills itself in), pick a card, then **Start shopping**. Scan real products or tap the quick-add tiles. Add the wine.
2. On the 5th item the cart flags something unscanned. Tap *I didn't add anything* and it becomes a check item.
3. Tap **Done** and pay. You get an amber Exit Pass with a live QR and a 12-digit recall number.
4. **Laptop or tablet at `/#/pos`:** tap the Magellan bar and hold the phone's QR to the camera, or key the recall number on the keypad and press Enter. The paid basket appears with **BAL DUE $0.00**, and the phone shows "Lane 4 has your basket".
5. Key `000000221474` (the paper bag barcode on the real lane) and press Enter. The bag is charged to the shopper's card and the phone gets a notification.
6. Tap the ID check, then **COMPLETE**. The receipt prints on the lane and the phone flips to "6s from Done to out the door".
7. Try `/#/sco` with a second trip, and a trip with no alcohol for a green "walk out" pass.

Account → Demo controls on the phone can force a green pass or a spot-check.

## Architecture

Static ES modules in `public/` with no build step. Third-party code is bundled in `public/vendor/`: the barcode decoder (ZXing WASM) and a QR code generator.

- `api/sync.js` → `lib/sync.js`: cross-device event relay. Devices poll every ~1s. Backed by Upstash Redis on Vercel, or memory under `npm start`. `BroadcastChannel` covers tabs on the same device.
- `api/lookup.js`: product identification by UPC
- `server.js`: local server serving the same routes

- `public/js/shared.js`: catalog, sync bus, and the **pass decision engine** (`decidePass`)
- `public/js/shopper.js`: shopper app
- `public/js/scanner.js`: camera scanning (native `BarcodeDetector`, or ZXing as a fallback on iOS)
- `public/js/store.js`: store radar, forecast, associate queue, simulated shoppers
- `public/js/pos.js`: register lane and self-checkout kiosk
- `public/js/pos-gateway.js`: **the simulated POS integration** (recall / add / void / check / close, EJ lines, events)
- `public/js/products.js`: product identification shared by the phone and the lanes
- `public/sw.js`: offline app shell, for dead zones in the store
