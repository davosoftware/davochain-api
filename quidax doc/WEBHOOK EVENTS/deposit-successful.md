Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Deposit Successful

This event is dispatched after the blockchain has confirmed the incoming transaction.

```json DEPOSIT.SUCCESSFUL(CRYPTO)
{
  "event": "deposit.successful",
  "data": {
    "id": "xofy3d26",
    "type": "coin_address",
    "currency": "trx",
    "amount": "3.0",
    "fee": "0.0",
    "txid": "c5aee052782c0f9419067b96c7a019ff21a7155878865c85e73ca76085736bab",
    "status": "accepted",
    "reason": null,
    "created_at": "2024-04-02T13:16:17.000Z",
    "done_at": null,
    "wallet": {
      "id": "060a4376-a043-4834-91f8-f59f05ccb174",
      "name": "Tron",
      "currency": "trx",
      "balance": "5.0",
      "locked": "0.0",
      "staked": "0.0",
      "user": {
        "id": "cd613c4d-4005-45ed-9e75-0283bb335f12",
        "sn": "QDX26RYDKVU",
        "email": "test@gmail.com",
        "reference": null,
        "first_name": "test",
        "last_name": "user",
        "display_name": null,
        "created_at": "2024-09-18T13:38:28.000Z",
        "updated_at": "2024-09-18T13:39:14.000Z"
      },
      "converted_balance": "1243.0",
      "reference_currency": "ngn",
      "is_crypto": true,
      "created_at": "2024-09-18T13:40:01.000Z",
      "updated_at": "2024-09-18T13:57:10.000Z",
      "blockchain_enabled": true,
      "default_network": "trc20",
      "networks": [
        {
          "id": "trc20",
          "name": "Tron Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        }
      ],
      "deposit_address": "TX35qctiFnjwd7AeNmVqwggrBh7qqWC4ad",
      "destination_tag": null
    },
    "user": {
      "id": "u2d7imxe",
      "sn": "QDXTEJ7YRMF",
      "email": "test@gmail.com",
      "reference": null,
      "first_name": "test",
      "last_name": "user",
      "display_name": null,
      "created_at": "2024-04-02T13:09:40.000Z",
      "updated_at": "2024-04-02T13:09:41.000Z"
    },
    "payment_transaction": {
      "status": "confirmed",
      "confirmations": 1,
      "required_confirmations": 1
    },
    "payment_address": {
      "id": "mzlhmte6",
      "reference": null,
      "currency": "trx",
      "address": "TKipGdUmft8UsHQsmLi8eaAX63RxxQt3cN",
      "network": "trc20",
      "user": {
        "id": "u2d7imxe",
        "sn": "QDXTEJ7YRMF",
        "email": "test@gmail.com",
        "reference": null,
        "first_name": "test",
        "last_name": "user",
        "display_name": null,
        "created_at": "2024-04-02T13:09:40.000Z",
        "updated_at": "2024-04-02T13:09:41.000Z"
      },
      "destination_tag": null,
      "total_payments": null,
      "created_at": "2024-04-02T13:12:11.000Z",
      "updated_at": "2024-04-02T13:12:12.000Z"
    }
  }
}
```
```json DEPOSIT.SUCCESSFUL(INTERNAL)
{
  "event": "deposit.successful",
  "data": {
    "id": "907cca0b-0c99-48d1-a63f-a2263fa064b3",
    "type": "internal",
    "currency": "ngn",
    "amount": "2796.92",
    "fee": "0.0",
    "txid": null,
    "status": "checked",
    "reason": null,
    "created_at": "2025-02-27T11:01:49.000Z",
    "done_at": "2025-02-27T11:01:48.000Z",
    "wallet": {
      "id": "ehrvhnfz",
      "name": "Naira",
      "currency": "ngn",
      "balance": "4695.4210029518954836",
      "locked": "0.0",
      "staked": "0.0",
      "user": {
        "id": "23azi7bj",
        "sn": "QDXXIRPXXKS",
        "email": "test@gmail.com",
        "reference": null,
        "first_name": "test",
        "last_name": "user",
        "display_name": "test",
        "created_at": "2021-04-09T09:48:14.000Z",
        "updated_at": "2025-01-08T13:09:44.000Z"
      },
      "converted_balance": "4695.4210029518954836",
      "reference_currency": "ngn",
      "is_crypto": false,
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2025-02-27T11:01:49.000Z",
      "blockchain_enabled": false,
      "default_network": null,
      "networks": [],
      "deposit_address": null,
      "destination_tag": null
    },
    "user": {
      "id": "23azi7bj",
      "sn": "QDXXIRPXXKS",
      "email": "test@gmail.com",
      "reference": null,
      "first_name": "test",
      "last_name": "user",
      "display_name": "test",
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2025-01-08T13:09:44.000Z"
    },
    "sender": "User Test"
  }
}
```

| Field                                             | Description                                                                                              | Type   |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------------- | :----- |
| event                                             | The webhook event action that triggered the webhook, e.g. DEPOSIT.SUCCESSFUL.                            | String |
| data                                              | All information related to this specific webhook.                                                        | Object |
| data.id                                           | The id attribute of the deposit transaction.                                                             | String |
| data.type                                         | This can be either coin\_address or internal.                                                            | String |
| data.currency                                     | This is the ticker sign of the crypto                                                                    | String |
| data.amount                                       | The deposit amount that is being moved.                                                                  | String |
| data.fee                                          | Transaction fee charged by the network.                                                                  | String |
| data.txId                                         | Transaction ID from the blockchain.                                                                      | String |
| data.status                                       | Transaction status this could be either submitted or confirmed.                                          | String |
| data.reason                                       | Transaction note.                                                                                        | String |
| data.created\_at                                  | The date the transaction was submitted.                                                                  | String |
| data.done\_at                                     | The data of the transaction was confirmed.                                                               | String |
| data.wallet                                       | All information related to the wallet this transaction is being carried out.                             | Object |
| data.wallet.id                                    | The ID of the receiving wallet.                                                                          | String |
| data.wallet.balance                               | The current balance of the receiving wallet.                                                             | String |
| data.wallet.currency                              | The currency of the receiving wallet.                                                                    | String |
| data.wallet.balance                               | The current balance of the receiving wallet.                                                             | String |
| data.wallet.locked                                | The current locked balance.                                                                              | String |
| data.wallet.stacked                               | The current balance is stacked.                                                                          | String |
| data.wallet.user                                  | All information related to the user of which this transaction is being carried out.                      | Object |
| data.wallet.converted\_balance                    | The converted balance of the wallet to the reference currency                                            | String |
| data.wallet.reference\_currency                   | The current reference currency of the wallet                                                             | String |
| data.wallet.is\_crypto                            | Identifies if the current wallet is crypto or fiat.                                                      | Bool   |
| data.wallet.created\_at                           | The date the wallet was initially created                                                                | String |
| data.wallet.updated\_at                           | The data in the wallet was updated                                                                       | String |
| data.wallet.deposit\_address                      | The address at which the user can accept a deposit                                                       | String |
| data.user                                         | All information related to the user of which this transaction is being carried out.                      | Object |
| data.user.id                                      | The receiver user-id                                                                                     | String |
| data.user.sn                                      | The receiver serial number                                                                               | String |
| data.user.email                                   | The receiver's email address                                                                             | String |
| data.user.reference                               | The receivers tag                                                                                        | String |
| data.user.first\_name                             | The receiver's first name                                                                                | String |
| data.user.last\_name                              | The receiver's last name                                                                                 | String |
| data.user.display\_name                           | The receiver username or display name                                                                    | String |
| data.user.created\_at                             | The date at which the user was created.                                                                  | String |
| data.user.updated\_at                             | The date at which the user attributes were updated.                                                      | String |
| data.payment\_transaction                         | The payment transaction object                                                                           | Object |
| data.payment\_transaction.status                  | The current status of the transaction, **confirmed** or **unconfirmed**.                                 | String |
| data.payment\_transaction.confirmations           | The number of times the blockchain has confirmed the transaction.                                        | String |
| data.payment\_transaction.required\_confirmations | The number of times the transaction has to be confirmed before being marked as a successful transaction. | String |
| data.payment\_address                             | The payment address object                                                                               | Object |
| data.payment\_address.id                          | The id of the payment address.                                                                           | String |
| data.payment\_address.currency                    | The currency of the wallet                                                                               | String |
| data.payment\_address.address                     | The deposit address of the cryptocurrency.                                                               | String |
| data.payment\_address.network                     | The network of which the deposit was made.                                                               | String |
| data.payment\_address.user                        | All information related to the user of which this transaction is being carried out.                      | Object |
| data.payment\_address.total\_payments             | The total balance of the wallet                                                                          | String |
| data.payment\_address.created\_at                 | The datetime the wallet was created.                                                                     | String |
| data.payment\_address.updated\_at                 | The datetime the wallet was updated.                                                                     | String |