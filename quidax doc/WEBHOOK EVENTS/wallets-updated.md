Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Wallet Updated

This event is dispatched whenever an authenticated initiates a transfer or receives deposits into a wallet

```json WALLET.UPDATED(CRYPTO)
{
   "event":"wallet.updated",
   "data":{
      "id":"cd90ef7e33e147bda85101afaf0fb87a1777971748043",
      "name":"USDT",
      "currency":"usdt",
      "balance":"0.072246",
      "locked":"0.0000000000",
      "staked":"0.0000000000",
      "user":{
         "id":"b465wwri",
         "sn":"b465wwri",
         "email":"testuser@gmail.com",
         "reference":null,
         "first_name":"test",
         "last_name":"user",
         "display_name":null,
         "created_at":"2021-04-09T12:54:18.000Z",
         "updated_at":"2026-05-04T11:08:17.000Z"
      },
      "converted_balance":"0.072246",
      "reference_currency":"USD",
      "is_crypto":true,
      "created_at":"2021-04-09T12:54:18.000Z",
      "updated_at":"2026-06-25T23:14:33.000Z",
      "blockchain_enabled":true,
      "default_network":"bep20",
      "networks":[
         {
            "id":"bep20",
            "name":"Binance Smart Chain",
            "deposits_enabled":true,
            "withdraws_enabled":true
         },
         {
            "id":"polygon",
            "name":"Polygon Network",
            "deposits_enabled":true,
            "withdraws_enabled":true
         },
         {
            "id":"trc20",
            "name":"Tron Network",
            "deposits_enabled":true,
            "withdraws_enabled":true
         },
         {
            "id":"erc20",
            "name":"Ethereum Network",
            "deposits_enabled":true,
            "withdraws_enabled":true
         },
         {
            "id":"solana",
            "name":"Solana Network",
            "deposits_enabled":true,
            "withdraws_enabled":true
         },
         {
            "id":"ton",
            "name":"TON Network",
            "deposits_enabled":true,
            "withdraws_enabled":true
         },
         {
            "id":"celo",
            "name":"CELO",
            "deposits_enabled":true,
            "withdraws_enabled":true
         },
         {
            "id":"optimism",
            "name":"OP Mainnet",
            "deposits_enabled":true,
            "withdraws_enabled":true
         },
         {
            "id":"arbitrum",
            "name":"Arbitrum One",
            "deposits_enabled":true,
            "withdraws_enabled":false
         },
         {
            "id":"lisk",
            "name":"LISK",
            "deposits_enabled":true,
            "withdraws_enabled":true
         }
      ],
      "deposit_address":"34cXpjix1YeRAWmLD8wviP7S1G43rhd3pp",
      "destination_tag":null
   }
}
```
```json WALLET.UPDATED
{
  "event": "wallet.updated",
  "data": {
    "id": "ehrvhnfz",
    "currency": "ngn",
    "balance": "540.574632524",
    "locked": "101.1",
    "staked": "0.0",
    "user": {
      "id": "23azi7bj",
      "sn": "QDXXIRPXXKS",
      "email": "test1223@gmail.com",
      "reference": null,
      "first_name": "Oye",
      "last_name": "Olalekan",
      "display_name": "appstate",
      "created_at": "2021-04-09T09:48:14.000Z",
      "updated_at": "2022-03-14T08:29:34.000Z"
    },
    "converted_balance": "540.574632524",
    "reference_currency": "ngn",
    "is_crypto": false,
    "created_at": "2021-04-09T09:48:14.000Z",
    "updated_at": "2022-10-04T15:31:23.000Z"
  }
}
```

| Field                    | Description                                                                            | Type    |
| :----------------------- | :------------------------------------------------------------------------------------- | :------ |
| event                    | The webhook event action that triggered the webhook, e.g. WALLETS.UPDATED.             | String  |
| data                     | All information related to this specific webhook.                                      | Object  |
| data.id                  | The id of the wallet.                                                                  | String  |
| data.name                | The name of the wallet.                                                                | String  |
| data.currency            | The currency of the wallet.                                                            | String  |
| data.balance             | The balance of the wallet.                                                             | String  |
| data.locked              | Locked balance of the wallet.                                                          | String  |
| data.staked              | Staked balance of the wallet.                                                          | String  |
| data.user                | The customer's account object                                                          | Object  |
| data.user.id             | The customer's id of the account                                                       | String  |
| data.user.sn             | The customer's serial number                                                           | String  |
| data.user.email          | The customer's email                                                                   | String  |
| data.user.reference      | The customer's reference                                                               | String  |
| data.user.first\_name    | The customer's first name                                                              | String  |
| data.user.last\_name     | The customer's last name                                                               | String  |
| data.user.display\_name  | The customer's display name                                                            | String  |
| data.user.created\_at    | The date on which the user was created                                                 | String  |
| data.user.updated\_at    | The date on which the user was updated                                                 | String  |
| data.blockchain\_enabled | Indicates whether blockchain is enabled for the wallet.                                | Boolean |
| data.converted\_balance  | The crypto balance converted to fiat.                                                  | String  |
| data.reference\_currency | The primary fiat currency of the wallet.                                               | String  |
| data.is\_crypto          | Boolean value to determine if the wallet is fiat or crypto.                            | String  |
| data.default\_network    | The customer's default network                                                         | String  |
| data.networks            | The list of available networks for that wallet                                         | String  |
| data.created\_at         | The date the wallet was created.                                                       | String  |
| data.updated\_at         | The date at which the wallet was updated, eg: when the balance has been updated.       | String  |
| data.deposit\_address    | This is the address of the wallet.                                                     | String  |
| data.destination\_tag    | The destination tag associated with the wallet, if applicable. This field is optional. | String  |