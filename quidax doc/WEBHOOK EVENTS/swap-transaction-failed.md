Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Swap Transaction Failed

This event is triggered when the swap transaction is failed.

```json
{
  "event": "swap_transaction.failed",
  "data": {
    "id": "kik76igi",
    "from_currency": "TRX",
    "to_currency": "USDT",
    "from_amount": "1.0",
    "received_amount": "153.66",
    "execution_price": "153.66",
    "status": "failed",
    "created_at": "2024-05-29T12:15:38.000Z",
    "updated_at": "2024-05-29T12:15:49.000Z",
    "swap_quotation": {
      "id": "ntpjg7qf",
      "from_currency": "TRX",
      "to_currency": "USDT",
      "quoted_price": "153.664",
      "quoted_currency": "NGN",
      "from_amount": "1.0",
      "to_amount": "153.66",
      "confirmed": true,
      "expires_at": "2024-05-29T12:15:48.000Z",
      "created_at": "2024-05-29T12:15:23.000Z",
      "updated_at": "2024-05-29T12:15:38.000Z",
      "user": {
        "id": "feeqirob",
        "sn": "QDXXIRPXXKS",
        "email": "test@gmail.com",
        "reference": null,
        "first_name": "TEST",
        "last_name": "USER",
        "display_name": null,
        "created_at": "2021-04-09T09:48:14.000Z",
        "updated_at": "2024-03-12T10:34:34.000Z"
      }
    },
    "user": {
      "id": "feeqirob",
      "sn": "QDXXIRPXXKS",
      "email": "test@gmail.com",
      "reference": null,
      "first_name": "TEST",
      "last_name": "USER",
      "display_name": null,
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2024-03-12T10:34:34.000Z"
    }
  }
}
```