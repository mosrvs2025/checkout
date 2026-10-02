# Security notes

Exit Pass is a prototype. This file covers what is protected today, and what a production version needs that a demo can skip.

## In place now

| Area | Protection |
|---|---|
| Cross-device messages | Every message from another device goes through one checkpoint (`receive()` in `public/js/shared.js`). It allowlists message types and entity-encodes every string before anything renders. HTML or script sent through sync shows up as plain text on every screen (covered by `npm test`). |
| Sync API (`/api/sync`) | Known message types only, 64 KB body cap, per-client rate limit (150 messages / 10 s, since a whole store shares one public IP), and `reset` requires `EXITPASS_ADMIN_KEY`. |
| Product lookup (`/api/lookup`) | Fixed upstream hosts (no SSRF), numeric codes only, rate limited, product text sanitized before display. |
| Browser hardening | Content-Security-Policy (scripts only from this origin; WebAssembly allowed for the barcode decoder), `nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera only for this site), `X-Frame-Options`. Same headers locally (`server.js`) and on Vercel (`vercel.json`). |
| Pass replay | The QR token rotates every 10 s and is accepted for 30 s, so screenshots go stale. A pass works once: lanes, self-checkout and the door all refuse a pass that's already been used. |
| Payments | None. Nothing is charged. Card data never touches the app; it only shows a saved-card label. |

## Needed before real customers

1. **Server-issued, signed pass tokens.** Today the token is derived from data every device on the sync channel can see. Production: an HMAC with a per-store secret, verified by the Basket API, never by the client.
2. **Authenticated devices.** Registers, door scanners and associate handhelds need device credentials (mTLS or signed device tokens) before they can recall, adjust or close a basket. Today any device that loads the site can act as a lane.
3. **Server-authoritative baskets.** Prices, deals, tax and totals must be computed on the server from the item master. Today the phone computes them, and a modified phone could under-report.
4. **Accounts.** Real Vons for U sign-in with OTP verification. The trust score must live on the server, per account, and reset whenever a check finds a discrepancy.
5. **Payments through the processor.** Pre-auth at Done, incremental auth for items added at the lane, capture at close, via a PCI-compliant processor SDK. Card numbers never in this codebase.
6. **Privacy.** Store location and shopping history are personal data. Keep retention short and give shoppers a clear way to delete their history.
7. **Audit trail.** Every recall, adjust, check and close is already written to the lane's electronic journal. Production should sign those entries and store them server-side for loss-prevention review.
