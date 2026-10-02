Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Wallet Address Generated

This event is dispatched whenever an authenticated user generates a new wallet address

```json WALLET.ADDRESS.GENERATED
{
  "event": "wallet.address.generated",
  "data": {
    "id": "v2txrv7q",
    "reference": null,
    "currency": "usdt",
    "address": "TMUER8WKoDt2VVzM7Ntt6PKTJNKgQzQgXv",
    "network": "trc20",
    "user": {
      "id": "nho3neuf",
      "sn": "QDXKA7XIYAE",
      "email": "test@testuser.com",
      "reference": null,
      "first_name": "test",
      "last_name": "user",
      "display_name": null,
      "created_at": "2024-03-22T11:08:26.000Z",
      "updated_at": "2024-03-22T11:08:27.000Z"
    },
    "destination_tag": null,
    "total_payments": null,
    "created_at": "2024-03-22T11:12:24.000Z",
    "updated_at": "2024-03-22T11:12:25.000Z"
  }
}
```

| Field                   | Description                                                                | Type   |
| :---------------------- | :------------------------------------------------------------------------- | :----- |
| event                   | The webhook event action that triggered the webhook, e.g. WALLETS.UPDATED. | String |
| data                    | All information related to this specific webhook.                          | Object |
| data.id                 | The id attribute of the wallet.                                            | String |
| data.currency           | The crypto ticker of the wallet.                                           | String |
| data.address            | The crypto address of the wallet.                                          | String |
| data.network            | The network associated with the address.                                   | String |
| data.user               | The customer's account object                                              | Object |
| data.user.id            | The customer's id of the account                                           | String |
| data.user.sn            | The customer's serial number                                               | String |
| data.user.email         | The customer's email                                                       | String |
| data.user.reference     | The customer's reference                                                   | String |
| data.user.first\_name   | The customer's first name                                                  | String |
| data.user.last\_name    | The customer's last name                                                   | String |
| data.user.display\_name | The customer's display name                                                | String |
| data.user.created\_at   | The date on which the user was created                                     | String |
| data.user.updated\_at   | The date on which the user was updated                                     | String |
| data.total\_payments    | The total amount in the wallet.                                            | String |
| data.created\_at        | The date the wallet was created.                                           | String |
| data.updated\_at        | The date the waller was updated.                                           | String |