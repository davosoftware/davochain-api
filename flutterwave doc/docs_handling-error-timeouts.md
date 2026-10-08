---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Handling Error Timeouts

Learn how to handle timeout errors from the Flutterwave API.

Payment systems rely on communication across several connections, handshakes, and dependencies to facilitate different payment flows. Occasionally, there could be a breakdown(timeout) in this communication, leading to system errors. A timeout does not always mean request failure; it could also mean the request is still processing.

Timeout error occurs when a system takes too long to process a request and send back a response, when this happens you get a 503 server error. Our system typically waits for 28 seconds before returning a timeout error response.

Here is what a typical 503 error response looks like:

```json 503 timeout
{
   "status":"error",
   "message":"An error occurred. Please contact support",
   "data":null
}
```

Factors such as server downtime, network problems, or other technical factors can cause a timeout.

<br />

# How to Handle a Timeout

When you receive a timeout error, you need to handle this carefully to prevent duplicate requests.

1. If the initial request was to create a payment, e.g., charging a customer, initiating payouts or bill payments, query the status of the transaction to confirm if the payment is being processed before retrying the request.
2. For other requests, retry the request after a short interval.

<br />

## Querying Transaction Status

To confirm the actual payment's status, you need to poll the payment status endpoint.

* For charges poll the verify [endpoint](/v3.0.0/reference/verify-transaction).

```curl Query Transaction Status
curl --request GET \
--url 'https://api.flutterwave.com/v3/transactions/:id/verify' \
--header 'Authorization: Bearer {{YOUR_SECRET_KEY}}' \
--header 'Content-Type: application/json' \
--header 'accept: application/json' \
```
```json 200 OK
{
  "status": "success",
  "message": "Transaction fetched successfully",
  "data": {
    "id": 288200108,
    "tx_ref": "LiveCardTest",
    "flw_ref": "YemiDesola/FLW275407301",
    "device_fingerprint": "N/A",
    "amount": 100,
    "currency": "NGN",
    "charged_amount": 100,
    "app_fee": 1.4,
    "merchant_fee": 0,
    "processor_response": "Approved by Financial Institution",
    "auth_model": "PIN",
    "ip": "::ffff:10.5.179.3",
    "narration": "CARD Transaction ",
    "status": "successful",
    "payment_type": "card",
    "created_at": "2020-07-15T14:31:16.000Z",
    "account_id": 17321,
    "card": {
      "first_6digits": "232343",
      "last_4digits": "4567",
      "issuer": "FIRST CITY MONUMENT BANK PLC",
      "country": "NIGERIA NG",
      "type": "VERVE",
      "token": "flw-t1nf-4676a40c7ddf5f12scr432aa12d471973-k3n",
      "expiry": "02/23"
    },
    "meta": null,
    "amount_settled": 98.6,
    "customer": {
      "id": 216519823,
      "name": "Yemi Desola",
      "phone_number": "N/A",
      "email": "user@gmail.com",
      "created_at": "2020-07-15T14:31:15.000Z"
    }
  }
}
```

<br />

* For payouts or transfers, query the transfer status [endpoint](/v3.0.0/reference/get-a-transfer).

```curl Query Transfer Status
curl --request GET \
--url 'https://api.flutterwave.com/v3/transfers/:id' \
--header 'Authorization: Bearer {{YOUR_SECRET_KEY}}' \
--header 'Content-Type: application/json' \
--header 'accept: application/json' \
```
```json 200 OK
{
  "status": "success",
  "message": "Transfer fetched",
  "data": {
    "id": 1933222,
    "account_number": "0251238458",
    "bank_code": "058",
    "full_name": " Flutterwave Developers",
    "created_at": "2020-06-11T00:36:20.000Z",
    "currency": "NGN",
    "debit_currency": "NGN",
    "amount": 300,
    "fee": 10.75,
    "status": "SUCCESSFUL",
    "reference": "new-actual-transfer-ref1",
    "meta": null,
    "narration": "Akhlm Pstmn Trnsfr xx007",
    "approver": null,
    "complete_message": "Transaction was successful",
    "requires_approval": 0,
    "is_approved": 1,
    "bank_name": "GTBANK PLC"
  }
}
```

<br />

* For bill payments, query the bill status [endpoint](/v3.0.0/reference/get-status-of-a-bill-payment).

```curl Query Transaction Status
curl --request GET \
--url 'https://api.flutterwave.com/v3/bills/{reference}' \
--header 'Authorization: Bearer {{YOUR_SECRET_KEY}}' \
--header 'Content-Type: application/json' \
--header 'accept: application/json' \
```
```json 200 OK
{
    "status": "success",
    "message": "Bill status fetch successful",
    "data": {
        "currency": "NGN",
        "customer_id": "+23490803840303",
        "frequency": "One Time",
        "amount": "200.00",
        "fee": 0,
        "product": "AIRTIME",
        "product_name": null,
        "commission": 0,
        "transaction_date": "2025-02-27T14:12:08.257Z",
        "customer_reference": "b1989abb-4167-41ce-b855-67377dbdt12acd",
        "country": "NG",
        "flw_ref": "BPUSSD1740665530501070",
        "tx_ref": "CF-FLYAPI-20250227021208256796740",
        "batch_id": 3764904,
        "extra": null,
        "product_details": "FLY-API-NG-AIRTIME"
    }
}
```

<br />

* If you get the timeout error when creating a refund or chargeback, query the status of the attempted [refund](/v3.0.0/reference/get-all-refunds) or [chargeback](/v3.0.0/reference/list-a-chargeback) before retrying the request.

After polling the request status, communicate the transaction status if it is `pending`. We'll send you a [webhook event](/v3.0.0/docs/webhooks) after processing the transaction. If you do not find any transaction after querying the status, please retry the request attempt.