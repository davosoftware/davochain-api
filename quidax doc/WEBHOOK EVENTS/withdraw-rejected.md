Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Withdraw Rejected

This event is dispatched whenever there is an issue in executing a **WITHDRAWAL** transaction

```json WITHDRAW.REJECTED
{
  "event": "withdraw.rejected",
  "data": {
    "id": "sm3l4byf",
    "reference": null,
    "type": "coin_address",
    "currency": "trx",
    "amount": "1.0",
    "fee": "1.0",
    "total": "2.0",
    "txid": null,
    "transaction_note": "Stay safe",
    "narration": "We love you.",
    "status": "Rejected",
    "reason": null,
    "created_at": "2021-11-25T15:51:08.000Z",
    "done_at": null,
    "recipient": {
      "type": "coin_address",
      "details": {
        "address": "TWMjBKD61DLXXQr6AvVnDMcVs5p46QSFz",
        "destination_tag": null,
        "name": null
      }
    },
    "wallet": {
      "id": "j5lzsrz7",
      "currency": "trx",
      "balance": "3.1690910029",
      "locked": "0.0",
      "staked": "0.0",
      "converted_balance": "183.015005417475",
      "reference_currency": "ngn",
      "is_crypto": true,
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2021-11-25T15:51:13.000Z",
      "deposit_address": "TZCDWPRaoMay6GSJpbv6yEk2Nn7nE11XwX",
      "destination_tag": null
    },
    "user": {
      "id": "23azi7bj",
      "sn": "QDXXIRPXXKS",
      "email": "johnsonoye123@gmail.com",
      "reference": null,
      "first_name": "Oye",
      "last_name": "Olalekan",
      "display_name": "appstate",
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2021-04-09T10:54:32.000Z"
    }
  }
}
```

| Field                                   | Description                                                                   | Type   |
| :-------------------------------------- | :---------------------------------------------------------------------------- | :----- |
| event                                   | The webhook event action that triggered the webhook, e.g. WITHDRAW\.REJECTED. | String |
| data                                    | All information related to this specific webhook.                             | Object |
| data.id                                 | The id attribute of the **withdrawal** transaction.                           | String |
| data.type                               | This can be **internal** or **coin\_address**                                 | String |
| data.currency                           | This can fiat or a crypto ticker                                              | String |
| data.amount                             | The amount being withdrawn                                                    | String |
| data.fee                                | The transaction that would be needed to execute this transaction.             | String |
| data.total                              | The addition between fee and amount                                           | String |
| data.txid                               | The transaction id.                                                           | String |
| data.transaction\_note                  | The note added to transaction by the sender                                   | String |
| data.narration                          | Transaction narration.                                                        | String |
| data.status                             | Transaction status, Done, Rejected.                                           | String |
| data.reason                             | Transaction reason.                                                           | String |
| data.created\_at                        | The date the transaction was created                                          | String |
| data.done\_at                           | The date the transaction was executed.                                        | String |
| data.recipient                          | Transaction recipient object                                                  | Object |
| data.recipient.type                     | Transaction type, this can be coin\_address or internal.                      | String |
| data.recipient.details                  | Transaction recipient object.                                                 | Object |
| data.recipient.details.address          | Receiving wallet address.                                                     | String |
| data.recipient.details.destination\_tag | Receiving wallet destination tag, this used to identify wallet.               | String |
| data.recipient.details.name             | The owner of the wallet's name.                                               | String |
| data.wallet                             | The debited wallet object.                                                    | Object |
| data.wallet.id                          | The debited wallet id.                                                        | String |
| data.wallet.currency                    | The currency of the debited wallet                                            | String |
| data.wallet.balance                     | The current balance of wallet after transfer.                                 | String |
| data.wallet.locked                      | Current balance that's pending approval                                       | String |
| data.wallet.staked                      | Current balance that's being stacked.                                         | String |
| data.wallet.converted\_balance          | Converted balance to primary currency.                                        | String |
| data.wallet.reference\_currency         | Wallet's primary currency.                                                    | String |
| data.wallet.is\_crypto                  | Wallet status if it's crypto or fiat                                          | String |
| data.wallet.created\_at                 | The date the wallet was created.                                              | String |
| data.wallet.updated\_at                 | The date the wallet was updated.                                              | String |
| data.wallet.deposit\_address            | The wallet address of the debited wallet.                                     | String |
| data.wallet.destination\_tag            | The destination tag of the debited wallet                                     | String |
| data.user                               | The customer's account object                                                 | Object |
| data.user.id                            | The customer's id of the account                                              | String |
| data.user.sn                            | The customer's serial number                                                  | String |
| data.user.email                         | The customer's email                                                          | String |
| data.user.reference                     | The customer's reference                                                      | String |
| data.user.first\_name                   | The customer's first name                                                     | String |
| data.user.last\_name                    | The customer's last name                                                      | String |
| data.user.display\_name                 | The customer's display name                                                   | String |
| data.user.created\_at                   | The date which the user was created                                           | String |
| data.user.updated\_at                   | The date which the user was updated                                           | String |