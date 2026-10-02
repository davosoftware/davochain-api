Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# How to generate a wallet address

Merchants can generate new wallet addresses for sub-users and main accounts, this can be used to collect deposits from different channels.

### **Making request**

Generate a new wallet address: send a post request to the [create wallet address](https://docs.quidax.io/v3.0/reference/create-payment-address-for-a-cryptocurrency) endpoint with the URL PARAMS.

**URL PARAMS:**

* **user\_id**: The User ID. Use 'me' if fetching wallets of the main authenticated user, use the user\_id if fetching the Sub-account linked to the authenticated user.
* **currency**: Currency. Allowed valued: qdx, usd, ngn, ghs, btc, usdt, busd, cfx, usdc, cnhc, eth, bnb, xrp, ltc, wkd, bch, doge, dash, trx, one, link, cake, xlm, axs, shib, afen, bls, fil, ada, dot, babydoge, xtz, matic, sfm, aave, wsg, ckt, floki, sol, mana, ftm, sand, slp, enj, lrc, ape, sushi, zil.

**QUERY PARAMS**

* network: Blockchain network supported by the currency

> 📘 Blockchain Networks
>
> Leaving the query parameter empty would create an address with the currency default network. To access the supported networks of the currency, use this endpoint. <https://docs.quidax.ng/reference/fetch-user-wallet>

**Request:**

```curl
curl --request POST \
     --url https://openapi.quidax.io/exchange-open-api/api/v1/users/<user_id>/wallets/<currency>/addresses/?network=<network> \
     --header 'Accept: application/json' \
     --header 'Authorization: Bearer <api_secret_key>'
```
```javascript
const options = {
  method: 'POST',
  headers: {accept: 'application/json', Authorization: 'Bearer s3cr3tk3y'}
};

fetch('https://www.quidax.com/api/v1/users/<user_id>/wallets/<currency>/addresses', options)
  .then(response => response.json())
  .then(response => console.log(response))
  .catch(err => console.error(err));
```
```php
<?php
require_once('vendor/autoload.php');

$client = new \GuzzleHttp\Client();

$response = $client->request('POST', 'https://www.quidax.com/api/v1/users/<user_id>/wallets/<currency>/addresses', [
  'headers' => [
    'Authorization' => 'Bearer s3cr3tk3y',
    'accept' => 'application/json',
  ],
]);

echo $response->getBody();
```
```python
import requests

url = "https://www.quidax.com/api/v1/users/<user_id>/wallets/<currency>/addresses"

headers = {
    "accept": "application/json",
    "Authorization": "Bearer s3cr3tk3y"
}

response = requests.post(url, headers=headers)

print(response.text)
```

> 📘 Wallet Address
>
> Wallet address are generated in the background so your integration would need to listen to [wallet.address.generated](https://docs.quidax.com/docs/wallet-address-generated) webhook event to get the newly generated address or make an API call to fetch the wallet address via the API endpoint to get the newly generated wallet address.

**Response:**

```json
{
  "status": "success",
  "message": "Successful",
  "data": {
    "id": "8aa1fd67-2b03-4059-909d-5b325c0bb317",
    "reference": null,
    "currency": "btc",
    "address": null,
    "network": "btc",
    "user": {
      "id": "dmdn34n4-2b03-4059-900d-444mff",
      "sn": "QDXXIRPXXKS",
      "email": "test@gmail.com",
      "reference": null,
      "first_name": "test",
      "last_name": "user",
      "display_name": "appstate",
      "created_at": "2021-04-09T10:48:14.000+01:00",
      "updated_at": "2024-03-12T11:34:34.000+01:00"
    },
    "destination_tag": null,
    "total_payments": null,
    "created_at": "2024-08-28T16:41:23.818+01:00",
    "updated_at": "2024-08-28T16:41:23.818+01:00"
  }
}
```