---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Settlements

Understanding how to manage settlements.

> 📘
>
> Settlements are supported for all payment methods.

Your transactions are incomplete until you receive the actual funds for your payments, this is called a settlement.

Typically, after collecting payments from a customer using their preferred payment methods, you'd receive the funds in your settlement account after a holding period. This [varies](https://flutterwave.com/ng/support/payments/settlement-schedule) based on the kind of payment made.

Before receiving your settlements, you can view them as the collection balance on your dashboard. Processed settlements are sent either to your bank account or your wallet (payout balance).

![](https://files.readme.io/7dc3ad86e77294daa965798c6f98b7675c9f0a0bef6585ebfe6eecf2565630da-image.png)

Successful transactions can either be settled successfully or flagged:

1. For successful settlements, transaction funds are settled to your bank account (settlement account) or your F4B wallet.
2. Flagged settlements are not released to the merchant. View the settlement details to understand why it was flagged and report the flagged settlement to our [support team](https://flutterwave.com/support/submit-request).

<br />

### Requirements

1. Ensure that your account is approved for live transactions – Only approved accounts are eligible for settlements. [Complete your KYC](/v3.0.0/docs/quickstart) process to secure account approval.
2. [Add](https://flutterwave.com/ng/support/payments/settlement-in-different-currencies) your preferred bank account details for settlements in the settings section on your dashboard.\
   Configure your preferred settlement destination – [choose](https://flutterwave.com/ng/support/payments/settlement-in-different-currencies) between your F4B wallet or bank account.
3. Your settlement should exceed the minimum settlement [threshold](https://flutterwave.com/ng/support/payments/minimum-settlement-threshold). If the cumulative value of your transactions is lower than this threshold, we'll batch your settlement, leading to a slightly longer settlement time.

<br />

### Transaction Batching

To ensure regular settlements, irrespective of the transaction volume on your account, we batch transactions when settling you i.e. transactions made before 23:59 GMT+1 on the settlement date are batched and settled at once.

A single settlement can contain several transactions. Transactions batched in the same settlement have the same currency, so you can have multiple settlements on the same day for different currencies.

```json Sample
{
    "status": "success",
    "message": "Settlement fetched",
    "data": {
        "id": 4982499,
        "account_id": 1834035,
        "merchant_name": "Adekunle Odujoko",
        "merchant_email": "kodujoko@gmail.com",
        "settlement_account": null,
        "bank_code": null,
        "transaction_date": "2024-06-26T01:00:00.000Z",
        "due_date": "2024-06-27T00:00:00.000Z",
        "processed_date": "2024-06-27T06:40:24.000Z",
        "status": "completed",
        "is_local": true,
        "currency": "NGN",
        "gross_amount": 200,
        "app_fee": 2.8,
        "merchant_fee": 0,
        "chargeback": 0,
        "refund": 0,
        "stampduty_charge": 0,
        "net_amount": 197.2,
        "transaction_count": 2,
        "processor_ref": "CC-SMT-469193240627064023",
        "disburse_ref": "CC-SMT-469193240627064023",
        "disburse_message": "Transfer was successful",
        "channel": "web",
        "destination": "wallet",
        "fx_data": "false",
        "flag_message": null,
        "meta": "[1402738209,1402749884]",
        "refund_meta": "[]",
        "chargeback_meta": "[]",
        "source_bankcode": null,
        "created_at": "2024-06-27T01:23:40.000Z",
        "transactions": [
            {
                "customer_email": "kodujoko@gmail.com",
                "flw_ref": "000015240626163808112035012551",
                "tx_ref": "Test_0007770017709",
                "id": 1444749988,
                "charged_amount": 100,
                "app_fee": 1.4,
                "merchant_fee": 0,
                "stampduty_charge": 0,
                "settlement_amount": 98.6,
                "status": "successful",
                "payment_entity": "bank_transfer",
                "transaction_date": "2024-06-26",
                "currency": "NGN",
                "card_locale": "LOCAL",
                "rrn": "N/A",
                "subaccount_settlement": 0
            },
            {
                "customer_email": "kodujoko@gmail.com",
                "flw_ref": "000015240626165204915842005443",
                "tx_ref": "Test_0007770017709",
                "id": 1444761926,
                "charged_amount": 100,
                "app_fee": 1.4,
                "merchant_fee": 0,
                "stampduty_charge": 0,
                "settlement_amount": 98.6,
                "status": "successful",
                "payment_entity": "bank_transfer",
                "transaction_date": "2024-06-26",
                "currency": "NGN",
                "card_locale": "LOCAL",
                "rrn": "N/A",
                "subaccount_settlement": 0
            }
        ]
    }
}
```

<br />

<br />

### Managing your Settlements

Flutterwave allows you to access relevant settlement information on your account. You can query the settlement's [endpoint](/v3.0.0/reference/get-all-settlements) or get the information directly on your [dashboard](https://flutterwave.com/us/support/payments/how-to-view-your-settlement-data-and-due-date). You can also download the list of the transactions that make up the settlement.

[block:image]
{
  "images": [
    {
      "image": [
        "https://files.readme.io/752d41338670001a2b7fe5ce848b063c90137eda0b5c237e5460530dc5f6ca61-image.png",
        null,
        ""
      ],
      "align": "center"
    }
  ]
}
[/block]

This information includes:

1. The settlement status
2. The settlement destination
3. Time the payment was settled
4. Settlement type i.e. local or International

When you query the settlement [endpoint](/v3.0.0/reference/get-all-settlements), specify filters to retrieve precise settlement information. We support filtering by page number (`page`), start date (`from`), end date (`to`), and `subaccount_id`.

```http curl
# Sample Request
curl --location 'https://api.flutterwave.com/v3/settlements' 
--header 'Authorization: Bearer YOUR_SECRET_KEY'

```

To retrieve the details of a specific settlement, include the settlement ID in your request.

```http Sample request
# Sample Request 
curl --location 'https://api.flutterwave.com/v3/settlements/4982499' 
--header 'Authorization: Bearer YOUR_SECRET_KEY'
```
```json Sample response
# Sample Response
{
    "status": "success",
    "message": "Settlement fetched",
    "data": {
        "id": 4982499,
        "account_id": 1834035,
        "merchant_name": "Adekunle Odujoko",
        "merchant_email": "kodujoko@gmail.com",
        "settlement_account": null,
        "bank_code": null,
        "transaction_date": "2024-06-26T01:00:00.000Z",
        "due_date": "2024-06-27T00:00:00.000Z",
        "processed_date": "2024-06-27T06:40:24.000Z",
        "status": "completed",
        "is_local": true,
        "currency": "NGN",
        "gross_amount": 200,
        "app_fee": 2.8,
        "merchant_fee": 0,
        "chargeback": 0,
        "refund": 0,
        "stampduty_charge": 0,
        "net_amount": 197.2,
        "transaction_count": 2,
        "processor_ref": "CC-SMT-469193240627064023",
        "disburse_ref": "CC-SMT-469193240627064023",
        "disburse_message": "Transfer was successful",
        "channel": "web",
        "destination": "wallet",
        "fx_data": "false",
        "flag_message": null,
        "meta": "[1402738209,1402749884]",
        "refund_meta": "[]",
        "chargeback_meta": "[]",
        "source_bankcode": null,
        "created_at": "2024-06-27T01:23:40.000Z",
        "transactions": [
            {
                "customer_email": "kodujoko@gmail.com",
                "flw_ref": "000015240626163808112035012551",
                "tx_ref": "Test_0007770017709",
                "id": 1444749988,
                "charged_amount": 100,
                "app_fee": 1.4,
                "merchant_fee": 0,
                "stampduty_charge": 0,
                "settlement_amount": 98.6,
                "status": "successful",
                "payment_entity": "bank_transfer",
                "transaction_date": "2024-06-26",
                "currency": "NGN",
                "card_locale": "LOCAL",
                "rrn": "N/A",
                "subaccount_settlement": 0
            },
            {
                "customer_email": "kodujoko@gmail.com",
                "flw_ref": "000015240626165204915842005443",
                "tx_ref": "Test_0007770017709",
                "id": 1444761926,
                "charged_amount": 100,
                "app_fee": 1.4,
                "merchant_fee": 0,
                "stampduty_charge": 0,
                "settlement_amount": 98.6,
                "status": "successful",
                "payment_entity": "bank_transfer",
                "transaction_date": "2024-06-26",
                "currency": "NGN",
                "card_locale": "LOCAL",
                "rrn": "N/A",
                "subaccount_settlement": 0
            }
        ]
    }
}
```

Merchants can also download this detailed settlement breakdown from their dashboards. Check [here](https://flutterwave.com/us/support/payments/how-to-view-your-settlement-data-and-due-date) for a guide.