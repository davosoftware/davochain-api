Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Order Cancelled

This webhook is triggered once your order has been cancelled.

```json
{
  "event": "order.cancelled",
  "data": {
    "id": "gauq444e",
    "reference": null,
    "market": {
      "id": "usdtngn",
      "base_unit": "USDT",
      "quote_unit": "NGN"
    },
    "side": "sell",
    "order_type": "limit",
    "price": {
      "unit": "NGN",
      "amount": "869.0"
    },
    "avg_price": {
      "unit": "NGN",
      "amount": "0.0"
    },
    "volume": {
      "unit": "USDT",
      "amount": "0.87"
    },
    "origin_volume": {
      "unit": "USDT",
      "amount": "0.87"
    },
    "executed_volume": {
      "unit": "USDT",
      "amount": "0.0"
    },
    "status": "cancel",
    "trades_count": 0,
    "created_at": "2023-07-27T23:00:20.000Z",
    "updated_at": "2023-07-27T23:02:02.000Z",
    "done_at": null,
    "user": {
      "id": "23azi7bj",
      "sn": "QDXXIRPXXKS",
      "email": "johnsonoye123@gmail.com",
      "reference": null,
      "first_name": "Oye",
      "last_name": "Olalekan",
      "display_name": "appstate",
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2022-03-14T08:29:34.000Z"
    },
    "trades": []
  }
}
```