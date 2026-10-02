Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Withdraw Successful

This event is dispatched whenever a withdrawal request has been successfully processed.

```json WITHDRAW.SUCCESSFUL(INTERNAL)
{
  "event": "withdraw.successful",
  "data": {
    "id": "y23dxeyz",
    "reference": null,
    "type": "internal",
    "currency": "ngn",
    "amount": "1.0",
    "fee": "0.0",
    "total": "1.0",
    "txid": "2112190829919858",
    "transaction_note": "Stay safe",
    "narration": "Payout",
    "status": "Done",
    "reason": null,
    "created_at": "2021-12-19T08:29:10.000Z",
    "done_at": null,
    "recipient": {
      "type": "internal",
      "details": {
        "user_id": "23azi7bj"
      }
    },
    "wallet": {
      "id": "dvs6ada6",
      "currency": "ngn",
      "balance": "10.187",
      "locked": "0.0",
      "staked": "0.0",
      "converted_balance": "10.18699999999999999986424664594645",
      "reference_currency": "ngn",
      "is_crypto": false,
      "created_at": "2021-12-15T20:19:52.000Z",
      "updated_at": "2021-12-19T08:29:14.000Z"
    },
    "user": {
      "id": "ptvpvtso",
      "sn": "QDXMDZLESLZ",
      "email": "tenst@gmail.com",
      "reference": null,
      "first_name": "testnnn",
      "last_name": "usernnnn",
      "display_name": null,
      "created_at": "2021-12-15T20:19:50.000Z",
      "updated_at": "2021-12-15T20:19:52.000Z"
    }
  }
}
```
```json WITHDRAW.SUCCESSFUL(CRYPTO).
{
  "event": "withdraw.successful",
  "data": {
    "id": "o6rz43si",
    "reference": null,
    "type": "coin_address",
    "currency": "trx",
    "amount": "1.0",
    "fee": "1.0",
    "total": "2.0",
    "txid": "44b538c2868cd682508c4dc18d910b73342b5bacdbc38e35af5b3bafb4779e08",
    "transaction_note": "Stay safe",
    "narration": "We love you.",
    "status": "Done",
    "reason": null,
    "created_at": "2021-11-25T15:55:51.000Z",
    "done_at": null,
    "recipient": {
      "type": "coin_address",
      "details": {
        "address": "TWMjBKD61DLXXQr6AvVnDMcVs5p46QSFzT",
        "destination_tag": null,
        "name": null
      }
    },
    "wallet": {
      "id": "j5lzsrz7",
      "currency": "trx",
      "balance": "1.1690910029",
      "locked": "0.0",
      "staked": "0.0",
      "converted_balance": "67.515005417475",
      "reference_currency": "ngn",
      "is_crypto": true,
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2021-11-25T15:55:54.000Z",
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

| Field                           | Description                                                                     | Type   |
| :------------------------------ | :------------------------------------------------------------------------------ | :----- |
| event                           | The webhook event action that triggered the webhook, e.g. WITHDRAW\.SUCCESSFUL. | String |
| data                            | All information related to this specific webhook.                               | Object |
| data.id                         | The id attribute of the **withdrawal** transaction.                             | String |
| data.type                       | This can be **internal** or **coin\_address**                                   | String |
| data.currency                   | This can fiat or a crypto ticker                                                | String |
| data.amount                     | The amount being withdrawn                                                      | String |
| data.fee                        | The transaction that would be needed to execute this transaction.               | String |
| data.total                      | The addition between fee and amount                                             | String |
| data.txid                       | The transaction id.                                                             | String |
| data.transaction\_note          | The note added to transaction by the sender                                     | String |
| data.narration                  | Transaction narration.                                                          | String |
| data.status                     | Transaction status, Done, Rejected.                                             | String |
| data.reason                     | Transaction reason.                                                             | String |
| data.created\_at                | The date the transaction was created                                            | String |
| data.done\_at                   | The date the transaction was executed.                                          | String |
| data.recipient                  | Transaction recipient object                                                    | Object |
| data.recipient.type             | Withdrawal recipient type: internal or coin\_address.                           | String |
| data.recipient.details          | Transaction recipient details object                                            | Object |
| data.recipient.details.user\_id | Receiver user\_id, this can be email or id of sub user                          | String |
| data.wallet                     | The debited wallet object.                                                      | Object |
| data.wallet.id                  | The debited wallet id.                                                          | String |
| data.wallet.currency            | The currency of the debited wallet                                              | String |
| data.wallet.balance             | The current balance of wallet after transfer.                                   | String |
| data.wallet.locked              | Current balance that's pending approval                                         | String |
| data.wallet.staked              | Current balance that's being stacked.                                           | String |
| data.wallet.converted\_balance  | Converted balance to primary currency.                                          | String |
| data.wallet.reference\_currency | Wallet's primary currency.                                                      | String |
| data.wallet.is\_crypto          | Wallet status if it's crypto or fiat                                            | String |
| data.wallet.created\_at         | The date the wallet was created.                                                | String |
| data.wallet.updated\_at         | The date the wallet was updated.                                                | String |
| data.user                       | The customer's account object                                                   | Object |
| data.user.id                    | The customer's id of the account                                                | String |
| data.user.sn                    | The customer's serial number                                                    | String |
| data.user.email                 | The customer's email                                                            | String |
| data.user.reference             | The customer's reference                                                        | String |
| data.user.first\_name           | The customer's first name                                                       | String |
| data.user.last\_name            | The customer's last name                                                        | String |
| data.user.display\_name         | The  customer's display name                                                    | String |
| data.user.created\_at           | The date which the user was created                                             | String |
| data.user.updated\_at           | The date which the user was updated                                             | String |