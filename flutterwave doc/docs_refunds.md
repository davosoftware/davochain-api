---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Refunds

Learn how to process refunds.

You can refund disputed transactions easily using our APIs. To initiate a refund, send a request to the [refund endpoint](/v3.0.0/reference/transaction-refund) with your transaction ID. For partial refunds, specify the refund amount. The refund amount is deducted from your available balance. Additionally, you can add a note to the refund by specifying `comments`.

```javascript Node.js
// Install with: npm i flutterwave-node-v3

const Flutterwave = require('flutterwave-node-v3');
const flw = new Flutterwave(process.env.FLW_PUBLIC_KEY, process.env.FLW_SECRET_KEY);
const response = await flw.Transaction.refund({
    id: transactionId,
    amount: amountToRefund,
    comments: "Product out of stock.",
});
```
```ruby
# Install with: gem install flutterwave_sdk

require 'flutterwave_sdk'

flw = Flutterwave.new(ENV["FLW_PUBLIC_KEY"], ENV["FLW_SECRET_KEY"], ENV["FLW_ENCRYPTION_KEY"])
transactions = Transactions.new(flw)
response = transactions.initiate_a_refund {
    id: transaction_id,
    amount: amount_to_refund,
    comments: "Product out of stock.",
}
print response
```
```shell cURL
curl --request POST 'https://api.flutterwave.com/v3/transactions/75923/refund' \
  --header 'Authorization: Bearer YOUR_SECRET_KEY'\
  --header 'Content-Type: application/json'\
  --data-raw '{
    "amount": 6900,
    "comments": "Product out of stock."
}'
```

The above code will initiate the refund process, and you will get a similar response to the one below:

```json
{
  "status": "success",
  "message": "Transaction refund initiated",
  "data": {
    "id": 75923,
    "account_id": 73362,
    "tx_id": 908790,
    "flw_ref": "URF_1577867664541_3572735",
    "wallet_id": 74639,
    "amount_refunded": 6900,
    "status": "completed",
    "destination": "payment_source",
    "meta": {
      "source": "availablebalance"
    },
    "created_at": "2021-01-24T09:18:37.366Z"
  }
}
```

> 🚧
>
> The minimum amount for refunds is `NGN 100` and `KES 10`. We return a 400 validation error for refund attempts lower than the expected minimum.

```json 400 Bad Request
{
    "status": "error",
    "message": "Amount should be above NGN100",
    "data": null
}
```

<br />

Refunds go through different stages before they are completed. Depending on the payment method used to charge the customer originally, these can have several statuses. Here is a list of supported refund statuses:

| Refund status             | Explanation                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `completed`               | Refund has been initiated and is pending disbursement to the customer.                          |
| `completed-bank-transfer` | Refund to Bank Account was successful.                                                          |
| `completed-momo`          | Refund to Mobile Money (MOMO) was successful.                                                   |
| `completed-mpgs`          | Refund was successful.                                                                          |
| `completed-offline`       | Refund was processed successfully offline or manually.                                          |
| `completed-preauth`       | A subset of `completed-mpgs`. This indicates a successful refund for preauth card transactions. |
| `pending-momo`            | Mobile Money (MOMO) refund is pending.                                                          |
| `processing`              | Refund is being processed.                                                                      |

Card refunds are completed between 3-15 days after the refund is initiated. Refunds to mobile money wallets take 3-5 days, while refunds to bank accounts are completed in 24 hours.

To verify the final status of your refunds, you can choose any of the following methods:

* Specify a Callback URL: Include the `callbackurl` field in your request body, and we will send the refund details to that URL when the refund is either completed or fails.
* Manually check the status: Use the “[Fetch a refunded transaction](/v3.0.0/reference/get-transaction-refunds)” endpoint with the refund ID (provided in the response above) to retrieve the current status of the refund.
* Enable webhooks: If webhooks are enabled, we will send a notification to your webhook URL with the refund details once the refund is either completed or fails.

> 📘 Webhooks
>
> By default webhooks will not be sent for refunds, you will need to reach out to the [internal team](https://flutterwave.com/gb/support/submit-request) to enable your account to receive webhooks for refunds.

```json
{
  "id": 89074,
  "AmountRefunded": 5000,
  "status": "completed",
  "FlwRef": "flwm3s4m0c1754324273641",
  "destination": "payment_source",
  "comments": "&quot;refunds for ABC goods",
  "settlement_id": "NEW",
  "meta": "{\"source\":\"ledgerbalance\",\"callbackurl\":\"https://webhook.site/0457f7f7-b760-4c54-9dfd-aa6696515751\",\"isPartialRefund\":true,\"disburse_ref\":\"CC-REFD-92026611744-flwm3s4m0c1754324273641\",\"disburse_status\":\"failed\"}",
  "createdAt": "2025-08-04T16:18:31.000Z",
  "updatedAt": "2025-08-04T16:18:32.000Z",
  "deletedAt": null,
  "walletId": 134244,
  "AccountId": 92319,
  "TransactionId": 8784082
}
```