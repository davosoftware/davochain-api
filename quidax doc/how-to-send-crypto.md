Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# How to send crypto.

Sending crypto on quidax is easy peasy, you just have to follow these steps

## Making Request.

To send crypto, you would need to call the API endpoint and pass the following parameters:

### PAYLOAD DATA

* **currency**: this is the cryptocurrency you want to send, examples: ngn, usdt, btc, ltc, eth, xrp, usdt, dash, trx, doge, xrp, bnb, matic, shib, axs, safemoon, cake, xlm, aave, link.
* **amount**: amount to transfer.
* **fund\_uid**: wallet address, or user id where you are planning to send the crypto
* **transaction\_note**: This is a transaction note that can be used internally.
* **reference**: unique reference to track the withdrawal
* **network**: preferred network; it uses the default network if the field is left empty. Kindly ensure that the network is supported and enabled before issuing the withdrawal. Use this [endpoint](https://docs.quidax.io/v3.0/reference/fetch-user-wallet) to fetch available networks for a currency.
* **narration**: transaction narration

### URL PARAMS

* **user\_id**: The User ID. Use 'me' for the main authenticated user, use the **user\_id** if sending from a Sub-account.

### Request:

```curl
curl --request POST \
     --url https://openapi.quidax.io/exchange-open-api/api/v1/users/<user_id>/withdraws \
     --header 'Accept: application/json' \
     --header 'Authorization: Bearer <api_secret_key>' \
     --header 'Content-Type: application/json' \
     --data '
{
     "currency": "usdt",
     "fund_uid": "TWMjBKD61DLXXQr6AvVnDMcVs5p46QSFzT",
     "amount": "5",
     "transaction_note": "Stay safe",
     "narration": "We love you.",
     "network": "trc20",
     "reference": "unique_reference"
}
'
```
```javascript
const options = {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
    Authorization: 'Bearer s3cr3tk3y'
  },
  body: JSON.stringify({
    currency: 'btc',
    fund_uid: '<fund_uid>',
    amount: '0.0000004',
    transaction_note: 'Stay safe',
    narration: 'We love you.'
  })
};

fetch('https://www.quidax.com/api/v1/users/<user_id>/withdraws', options)
  .then(response => response.json())
  .then(response => console.log(response))
  .catch(err => console.error(err));
```
```python
import requests

url = "https://www.quidax.com/api/v1/users/<user_id>/withdraws"

payload = {
    "currency": "btc",
    "amount": "0.0000004",
    "fund_uid": "<fund_uid>",
    "transaction_note": "Stay safe",
    "narration": "We love you."
}

headers = {
    "accept": "application/json",
    "content-type": "application/json",
    "Authorization": "Bearer s3cr3tk3y"
}

response = requests.post(url, json=payload, headers=headers)

print(response.text)
```

### Response:

```json SUCCESS
{
  "status": "success",
  "message": "Successful",
  "data": {
    "id": "f7ud47rz",
    "reference": null,
    "type": "coin_address",
    "currency": "usdt",
    "amount": "1.0",
    "fee": "1.0",
    "total": "2.0",
    "txid": null,
    "transaction_note": "love you",
    "narration": "smile more",
    "status": "Processing",
    "reason": null,
    "created_at": "2021-11-24T14:47:11.000Z",
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
      "balance": "0.0000020029",
      "locked": "2.0",
      "staked": "0.0",
      "converted_balance": "0.00011356443",
      "reference_currency": "ngn",
      "is_crypto": true,
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2021-11-24T14:47:11.000Z",
      "deposit_address": "TZCDWPRaoMay6GSJpbv6yEk2Nn7nE11XwX",
      "destination_tag": null
    },
    "user": {
      "id": "23azi7bj",
      "sn": "QDXXIRPXXKS",
      "email": "testuser@gmail.com",
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

> 📘 WIthdraw Status
>
> Withdrawals are processed in the background so your integrations would need to listen to [withdraw.successful](https://docs.quidax.com/docs/withdraw-successful) or [withdraw.rejected](https://docs.quidax.com/docs/withdraw-rejected) webhook to get the finally status of the withdrawal.

Here is a link to the API reference: <https://docs.quidax.io/v3.0/reference/create-withdrawal>