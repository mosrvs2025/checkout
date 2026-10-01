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
| `/` | Shopper (phone) | Scan → live total → Done → Exit Pass → receipt with time saved |
| `/#/associate` | Associate (phone/tablet) | Verification queue showing only the items to check. One tap clears the shopper. |
| `/#/store` | Front-end lead (screen/tablet) | Store radar, KPIs, 2½-minute arrival forecast, staffing recommendation, live feed |
| `/#/demo` | Presenting on a laptop | Phone and store dashboard side by side, synced live |

## Run it

```bash
npm start          # zero dependencies, Node 18+
```

Open `http://localhost:5173/#/demo` on a laptop. The server prints a LAN URL too: open `/` on your phone and `/#/associate` on another device, and a tap on the associate device turns the shopper's pass green instantly.

**Camera scanning needs HTTPS.** Over plain LAN HTTP the app falls back to typing a UPC and the "Quick add" tiles, which simulate scanning. For real barcode scanning in a store:
- Deploy to GitHub Pages (workflow included; enable Pages → "GitHub Actions" in repo settings). Single-device sync works there, including `/#/demo`.
- Or tunnel the local server for HTTPS plus cross-device sync, e.g. `npx localtunnel --port 5173` or `cloudflared tunnel --url http://localhost:5173`.

Any real product barcode works. Names are looked up on Open Food Facts and prices are simulated.

## Demo script (60 seconds)

1. Start shopping and add a few items. The total ticks up and the dashboard dot moves through the aisles.
2. On the 5th item the cart "feels" something unscanned. Resolve it, or tap *I didn't add anything* to see that become a check item.
3. Add wine, then tap **Done**. You get an amber pass: "Associate checks only these 2."
4. On the associate screen, tap **Looks good**. The phone flips to the receipt: *"from Done to out the door: 9s"*, compared with the current lane wait.
5. Start a new trip without alcohol or high-value items and you get a green pass: **"You're done. Walk out."**

Use the **?** button on the phone to force a green pass or a spot-check and to restart the trip.

## Architecture

Static ES modules in `public/` with no build step. `server.js` is a ~70-line Node server with no dependencies. It serves the files and relays trip state across devices over Server-Sent Events. Without it, tabs on the same device still sync through `BroadcastChannel`.

- `public/js/shared.js`: catalog, sync bus, and the **pass decision engine** (`decidePass`)
- `public/js/shopper.js`: shopper app
- `public/js/scanner.js`: camera scanning (native `BarcodeDetector`, or ZXing as a fallback on iOS)
- `public/js/store.js`: store radar, forecast, associate queue, simulated shoppers
