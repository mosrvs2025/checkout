# Exit Pass ↔ POS integration

How Exit Pass plugs into the lanes Vons already has, and what the prototype simulates.

## What's on the lane today

From the Pasadena store's front end:

| Component | Hardware/software | Role in Exit Pass |
|---|---|---|
| POS application | **Toshiba TCx SKY** (Linux POS OS), network-booted from the store controller (PXE / emBoot) | Hosts the Exit Pass extension |
| Scanner/scale | **Datalogic Magellan** bi-optic | Reads the Exit Pass QR from the shopper's phone |
| POS keyboard | Numeric keypad with Sub Total / Enter / Cancel | Fallback: cashier keys the 12-digit recall number |
| In-store barcodes | `0 000000 22147 4` (paper bag charge) and similar | Shows the store already uses restricted-range codes for function items. The recall number follows the same pattern. |

None of this hardware needs replacing.

## Flow at the lane

```
Phone (Exit Pass)                 Lane (TCx SKY + extension)              Exit Pass Basket API
─────────────────                 ───────────────────────────             ────────────────────
Tap Done → card pre-auth  ───────────────────────────────────────────────▶ basket stored, PREAUTH
Pass shows QR  EP1:<trip>:<token>
           └──── Magellan reads QR ──▶ extension sees EP1: prefix
                                       recall(code, lane) ───────────────▶ validate token, lock basket
                                       ◀──────────────── lines + tender (balance $0.00) + checks
                                       cashier does the 1–3 checks
                                       (missed item?) addItem ───────────▶ incremental capture on card
                                       close(txn) ───────────────────────▶ capture final amount, unlock
Phone flips to receipt ◀──────────────────────────────────────────────── pos.close event
                                       TLOG / EJ written as a normal transaction
```

The transaction lands in TLOG as an ordinary sale with a dedicated tender type (`EXIT_PASS_PREAUTH`). Sales audit, loss prevention reporting and settlement keep working without changes.

## The contract (implemented in `public/js/pos-gateway.js`)

| Operation | Purpose | Notes |
|---|---|---|
| `recall(code, lane)` | Load a paid basket onto the lane | Accepts the QR payload `EP1:<tripId>:<token>`, the 12-digit recall number `98xxxxxxxxxC`, or a 6-character trip ID. Errors: `E_FORMAT`, `E_NOT_FOUND`, `E_NOT_PAID`, `E_TOKEN` (expired or screenshotted pass). |
| `addItem(txn, item)` | Cashier scans something that wasn't in the basket | Charges the item plus tax to the shopper's card (incremental auth). The phone updates live. No void and re-ring. |
| `voidItem(txn, key)` | Remove an item | Refunds the shopper's card. |
| `confirmCheck(txn, key)` | Mark an ID or spot check done | `close` is blocked until every check is done. |
| `close(txn, operator)` | Finish and release the shopper | Writes the closing EJ line and emits `pos.close`. The phone shows the receipt. |
| `tenderCard(lane, lines)` | Regular sale | The lane still works normally for shoppers without the app. |

Every call writes an electronic journal line (visible under *Electronic journal (TLOG)* on the register screen) and emits a `pos.*` event to the phone and the store dashboard.

### Pass codes

- **QR** `EP1:<tripId>:<token>`. The token rotates every 10 seconds, and the lane accepts the current token plus up to 30 seconds of older ones. A screenshot stops working after about 30 seconds. In production the token would be an HMAC signed by the server with a per-store key, not a client-side hash.
- **Recall number:** 12 digits, prefix `98` (restricted in-store range), plus a GS1 check digit. A cashier can key it on the existing keypad if 2D scanning is disabled on the Magellan.

## Path to a real integration

1. **Scanner:** confirm the Magellan model and firmware have 2D/QR decoding enabled and can read phone screens (common on current Magellan imagers, but it may be off in the store config). Until then, the keyed recall number works on any lane.
2. **POS extension:** write a TCx SKY application extension (Toshiba's extension points / user exits in the store's POS application) that:
   - recognizes the `EP1:` prefix or `98` range on scanner input;
   - calls the Basket API over the store network;
   - adds the returned lines as item records and an `EXIT_PASS_PREAUTH` tender;
   - shows a check prompt for each flagged item (age verification reuses the existing alcohol and tobacco ID flow; it's the same pink "CHECK ALL IDs" rule);
   - calls `close` when the transaction ends.
3. **Basket API:** a small service next to the store controller (or in the cloud). It owns baskets, issues signed tokens, and talks to the payment processor for pre-auth, incremental auth and capture.
4. **Item master and pricing:** the phone gets prices from the same item file the lanes use, so totals match to the penny, including Vons for U member pricing.
5. **Self-checkout:** the same extension runs on SCO lanes. Checks route to the attendant station, as age verification does today.

## What the prototype simulates

| Real system | Prototype |
|---|---|
| Payment pre-auth, incremental auth, capture | Random auth codes and computed amounts |
| Item master and prices | Small catalog plus product lookup by UPC; prices are stable per UPC but made up |
| Basket API + store network | `lib/sync.js` (Upstash Redis on Vercel, in memory locally) relaying `trip` and `pos.*` events |
| TCx SKY screen + extension | `#/pos` (register) and `#/sco` (self-checkout) |
| Magellan scanner | Device camera (QR + UPC) or keyed entry on the on-screen keypad |
| Cart weight sensor | Fires on the 5th item of every trip so it can be demoed |
