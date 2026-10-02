Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Swap Transaction Completed

This event is triggered when the swap transaction is completed.

```json
{
  "event": "swap_transaction.complete",
  "data": {
    "id": "923a4845-4f61-4e9c-81dc-f02b35738535",
    "from_currency": "NGN",
    "to_currency": "USDT",
    "from_amount": "2000.0000000000000000",
    "received_amount": "1.4469000000000000",
    "execution_price": "0.0007234895347238",
    "status": "completed",
    "created_at": "2026-02-18T12:51:26.227Z",
    "updated_at": "2026-02-18T12:51:26.000Z",
    "swap_quotation": {
      "id": "75982c69e9b3836134140c5a1c87faaa",
      "confirmed": true,
      "from_currency": "NGN",
      "to_currency": "USDT",
      "quoted_price": "0.000723489534723800",
      "quoted_currency": "USDT",
      "from_amount": "2000.000000000000000000",
      "to_amount": "1.446900000000000000",
      "expires_at": "2026-02-18T12:51:29.000Z",
      "created_at": "2026-02-18T12:51:18.000Z",
      "updated_at": "2026-02-18T12:51:26.000Z",
      "user": {
        "id": null,
        "sn": "Qw1os7uj7",
        "email": "test+merchant@quidax.com",
        "reference": null,
        "first_name": null,
        "last_name": null,
        "display_name": null,
        "created_at": "2026-02-09T13:22:14.000Z",
        "updated_at": "2026-02-13T10:45:42.000Z"
      }
    },
    "user": {
      "id": null,
      "sn": "Qw1os7uj7",
      "email": "test+merchant@quidax.com",
      "reference": null,
      "first_name": null,
      "last_name": null,
      "display_name": null,
      "created_at": "2026-02-09T13:22:14.000Z",
      "updated_at": "2026-02-13T10:45:42.000Z"
    }
  }
}
```