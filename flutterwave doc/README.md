# Flutterwave v3: vendor docs snapshot and sandbox findings

A snapshot of the Flutterwave v3 documentation (developer.flutterwave.com) that
the naira rail relies on, taken on 7 Oct 2026, plus what the sandbox actually did
that day. Where the two disagree, the sandbox wins.

Design: `docs/superpowers/specs/2026-10-07-flutterwave-ngn-deposits-design.md`
(workspace root). Fixtures captured from the sandbox run live in
`api/src/flutterwave/__fixtures__/`.

## Sandbox findings (test mode, 7 Oct 2026)

| Topic | Observed |
| --- | --- |
| Static account without a BVN or NIN | 400 "BVN or NIN is required for static account number" |
| The same `tx_ref` twice | A second account with a new `order_ref`. Creation is **not** idempotent. |
| Test-mode account numbers | Every account is `0067100155` at "Mock Bank". BVNs are not validated. |
| Deactivate / reactivate | Works. `GET /virtual-account-numbers/{order_ref}` shows `account_status`. |
| Bank-transfer charge | Auto-paid within seconds in test mode |
| Webhook format | **A flat legacy body** (`id`, `txRef`, `appfee`, `merchantbearsfee`, `"event.type": "BANK_TRANSFER_TRANSACTION"`), not the documented `{event, data}` |
| `verif-hash` header | Present, and equal to the dashboard's secret hash |
| Verify by id | `amount` = `charged_amount` = 1500, `app_fee` 21, `amount_settled` 1479, plus `meta.virtualaccountnumber` and `meta.originatorname` |
| `GET /transactions` | **Returned zero rows** for every window and filter, even for a verified payment |
| Full refund with no settled balance | 400 "Some error occured", `data` "Error: Insufficient Wallet Balance". Nothing was created. |
| ₦50 partial refund | Accepted, then `processing` → `completed`, while `meta.disburse_status` was "failed" ("below minimum limit of 100") |
| `GET /refunds?id=<transaction id>` | Lists a transaction's refunds |
| Payout without IP whitelisting | 400 "Please enable IP Whitelisting to access this service" |
| `/banks/NG` | 598 banks; code `090567` appears twice (Flutterwave MFB and Orokam MFB) |
| Balances | Stayed 0 in test mode, because test collections don't settle |
