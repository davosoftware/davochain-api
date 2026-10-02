Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Order Done

This webhook is dispatched when your order has matched on the orderbook.

```json
{
  "event": "order.done",
  "data": {
    "id": "mxduxiot",
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
      "amount": "865.0"
    },
    "avg_price": {
      "unit": "NGN",
      "amount": "867.7"
    },
    "volume": {
      "unit": "USDT",
      "amount": "0.0"
    },
    "origin_volume": {
      "unit": "USDT",
      "amount": "0.87"
    },
    "executed_volume": {
      "unit": "USDT",
      "amount": "0.87"
    },
    "status": "done",
    "trades_count": 1,
    "created_at": "2023-07-27T23:02:57.000Z",
    "updated_at": "2023-07-27T23:02:58.000Z",
    "done_at": null,
    "user": {
      "id": "23azi7bj",
      "sn": "QDXXIRPXXKS",
      "email": "test@gmail.com",
      "reference": null,
      "first_name": "test",
      "last_name": "ola",
      "display_name": "appstate",
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2022-03-14T08:29:34.000Z"
    },
    "trades": [
      {
        "id": "7k6c2iy3",
        "market": {
          "id": "usdtngn",
          "base_unit": "USDT",
          "quote_unit": "NGN"
        },
        "price": {
          "unit": "NGN",
          "amount": "867.7"
        },
        "volume": {
          "unit": "USDT",
          "amount": "0.87"
        },
        "total": {
          "unit": "NGN",
          "amount": "754.899"
        },
        "created_at": "2023-07-27T23:02:58.000Z",
        "updated_at": "2023-07-27T23:02:58.000Z"
      }
    ]
  }
}
```