---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Transaction Verification

Learn how to verify your transactions.

After a charge is completed successfully, you should verify that the payment was successful with Flutterwave before giving value to your customers in your application. This serves as a failsafe, ensuring that the details of the payment is as expected.

Here are some important things to check for when verifying the payment:

* Verify that the transaction reference matches the one you generated
* Verify that the status of the transaction is `successful`.
* Verify that the currency of the payment is as expected.
* Verify if the amount paid is greater or equal to the amount you expect. If the amount was greater, you can give the customer value and refund the rest.

To verify payments, use the [verify transaction endpoint](/v3.0.0/reference/verify-transaction), passing in the transaction ID in the URL. You can get the transaction ID from the `data.id` field that's present in the response you get after creating a transaction and in the webhook payload you will receive for the transaction.

Here is an example of how you would verify a transaction in some of our [backend SDKs](/v3.0.0/docs/directory).

```javascript Node.js
// Install with: npm i flutterwave-node-v3
const Flutterwave = require("flutterwave-node-v3");
const flw = new Flutterwave(process.env.FLW_PUBLIC_KEY, process.env.FLW_SECRET_KEY);

flw.Transaction.verify({ id: String(transactionId) })
  .then((response) => {
    const tx = response.data;
    if (
      tx.status === "successful" &&
      tx.tx_ref === expectedReference &&
      tx.currency === expectedCurrency &&
      Number(tx.amount) >= expectedAmount
    ) {
      // Success! Confirm the customer's payment
    } else {
      // Inform the customer their payment was unsuccessful
    }
  })
  .catch(console.error);
```
```php PHP
<?php
declare(strict_types=1);

// Install with: composer require flutterwavedev/flutterwave-v3
require __DIR__ . '/vendor/autoload.php';

use Flutterwave\Flutterwave;
use Flutterwave\Service\Transactions;

Flutterwave::bootstrap(); // reads FLW_* environment variables

$transactions = new Transactions();
$response = $transactions->verify((string) $transactionId);
$tx = $response->data;

if (
    $tx->status === 'successful'
    && $tx->tx_ref === $expectedReference
    && $tx->currency === $expectedCurrency
    && (float) $tx->amount >= (float) $expectedAmount
) {
    // Success! Confirm the customer's payment
} else {
    // Inform the customer their payment was unsuccessful
}
```
```ruby
# Install with: gem install flutterwave_sdk
require "flutterwave_sdk"

flw = Flutterwave.new(ENV["FLW_PUBLIC_KEY"], ENV["FLW_SECRET_KEY"], ENV["FLW_ENCRYPTION_KEY"])
transactions = Transactions.new(flw)
response = transactions.verify_transaction transaction_id
tx = response["data"]

if tx["status"] == "successful" &&
   tx["tx_ref"] == expected_reference &&
   tx["currency"] == expected_currency &&
   tx["amount"].to_f >= expected_amount
  # Success! Confirm the customer's payment
else
  # Inform the customer their payment was unsuccessful
end
```
```curl
curl --request GET "https://api.flutterwave.com/v3/transactions/123456/verify" \
  --header "Authorization: Bearer $FLW_SECRET_KEY"
```

You will get any of the response similar to the ones below:

```json Success Response
{
  "status": "success",
  "message": "Transaction fetched successfully",
  "data": {
    "id": 1163068,
    "tx_ref": "akhlm-pstmn-blkchrge-xx6",
    "flw_ref": "FLW-M03K-02c21a8095c7e064b8b9714db834080b",
    "device_fingerprint": "N/A",
    "amount": 3000,
    "currency": "NGN",
    "charged_amount": 3000,
    "app_fee": 1000,
    "merchant_fee": 0,
    "processor_response": "Approved",
    "auth_model": "noauth",
    "ip": "pstmn",
    "narration": "Kendrick Graham",
    "status": "successful",
    "payment_type": "card",
    "created_at": "2020-03-11T19:22:07.000Z",
    "account_id": 73362,
    "amount_settled": 2000,
    "card": {
      "first_6digits": "553188",
      "last_4digits": "2950",
      "issuer": " CREDIT",
      "country": "NIGERIA NG",
      "type": "MASTERCARD",
      "token": "flw-t1nf-f9b3bf384cd30d6fca42b6df9d27bd2f-m03k",
      "expiry": "09/22"
    },
    "customer": {
      "id": 252759,
      "name": "Kendrick Graham",
      "phone_number": "0813XXXXXXX",
      "email": "user@example.com",
      "created_at": "2020-01-15T13:26:24.000Z"
    }
  }
}
```
```json Transaction Not Found
{
  "status": "error",
  "message": "No transaction was found for this id",
  "data": null
}
```

<br />

The transaction details are contained in the `data` object. For instance:

* The status of the transaction is in the `data.status`.

* The details of the customer are in the `data.customer` field.

* The `data.charged_amount` field says how much the customer was charged while `data.amount_settled` tells you how much you will be receiving from the transaction.

Some fields will vary depending on the type of transaction for instance, the `card` object will only be present for card transactions.