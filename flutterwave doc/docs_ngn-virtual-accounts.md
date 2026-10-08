---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# NGN Virtual Accounts

Learn how to create and manage a Nigerian Virtual Account.

> 🚧
>
> This is available to Nigerian merchants by default. For non-NG merchants, you'll need to request for this feature on your account. To do so, please email us at <hi@flutterwavego.com>.

Virtual accounts are generated bank account details (account number and bank name) that allow Flutterwave merchants to receive NGN payments from customers via direct bank transfers. There are two types of virtual accounts you can create:

* Dynamic Virtual Accounts
* Static Virtual Accounts

We recommend starting with the [introduction](/v3.0.0/docs/virtual-account) to understand the fundamentals before proceeding.

## Creating a Dynamic Virtual Account

To create a virtual account, send a request to the [create](/v3.0.0/reference/create-a-virtual-account-number-1) virtual account endpoint, specifying an `amount` greater than zero and the customer's  `email`.

```curl
curl --request POST 'https://api.flutterwave.com/v3/virtual-account-numbers' \
  --header 'Authorization: Bearer YOUR_SECRET_KEY' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "email":"user@example.com",
    "amount": 100,
    "tx_ref":"apex_tx-002201",
    "phonenumber":"08100000000",
    "firstname":"John",
    "lastname":"Doe",
    "narration":"Kids Foundation",
    "bank_code":"090567"
}'

```

You'll get a response similar to this:

```json 200 Ok
{
    "status": "success",
    "message": "Virtual account created",
    "data": {
        "response_code": "02",
        "response_message": "Transaction in progress",
        "flw_ref": "UAYF2045178111012980726935",
        "order_ref": "URF_1781110128750_5918935",
        "account_number": "9519802749",
        "frequency": "N/A",
        "bank_name": "Flutterwave MFB",
        "created_at": "2026-06-10 17:48:49",
        "expiry_date": "2026-06-10 18:48:49",
        "note": "Please make a bank transfer to Tester FLW",
        "amount": "102.00"
    }
}
```

The response will include a `response_code` of `02` and a `response_message` of `"Transaction in progress"`, indicating that the virtual account has been successfully created and is ready to receive payments. The response body will also contain the **bank name** and **account number**. You can display these details to your customer to facilitate payment via bank transfer.

Customers are expected to complete the payment before the `expiry_date` of the virtual account. Once the customer completes a payment, we will send a [webhook](/v3.0.0/docs/virtual-account#virtual-account-webhooks)  to notify you of the transaction status.

<br />

## Creating a Static Virtual Account

> 🚧
>
> To create a static NGN Virtual Account, you need your customer's NIN or BVN.

You can generate a virtual account using the same [create virtual account endpoint](/v3.0.0/reference/create-a-virtual-account-number-1), which is supported in our [backend SDKs](/v3.0.0/docs/directory). You'll need to specify the customer's email address and BVN to associate with the account number.

```shell cURL
curl --request POST 'https://api.flutterwave.com/v3/virtual-account-numbers' \
  --header 'Authorization: Bearer YOUR_SECRET_KEY' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "email":"tester@flutterwavego.com",
    "tx_ref":"apex_tx_ref-002201",
    "phonenumber":"08100000000",
    "is_permanent": true,
    "firstname":"John",
    "lastname":"Doe",
    "narration":"Kids Foundation",
    "bank_code":"090567",
    "bvn": "1234567890"
}'

```
```php
// Install with: composer require flutterwavedev/flutterwave-v3

$flw = new \Flutterwave\Rave(getenv('FLW_SECRET_KEY')); // Set `PUBLIC_KEY` as an environment variable
$virtualAccountsService = new \Flutterwave\VirtualAccount();
$details = [
    "email" => "tester@flutterwavego.com",
    "tx_ref" =>"apex_tx_ref-002201",
    "phonenumber" => "08100000000",
    "is_permanent" => true,
    "firstname" =>"Flutterwave",
    "lastname" => "Developers",
    "narration" =>"Kids Foundation",
    "bvn" => "1234567890"
];
$response = $virtualAccountsService->createVirtualAccount($details);
```
```python
# Install with: pip install rave_python

import os
from rave_python import Rave

rave = Rave(os.getenv("FLW_PUBLIC_KEY"), os.getenv("FLW_SECRET_KEY"))
res = rave.VirtualAccount.create({
    "email": "tester@flutterwavego.com",
  	"tx_ref":"apex_tx_ref-002201",
    "phonenumber":"08100000000",
    "is_permanent": true,
    "firstname":"Flutterwave",
    "lastname":"Developers",
    "narration":"Kids Foundation",
    "bvn": "1234567890"
})
print(res)
```

There are more options available when generating static virtual accounts. You can also set the following:

| Parameters  | Definition                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `amount`    | The amount to be collected per transaction.                                                     |
| `frequency` | The number of times the account can be used before expiring.                                    |
| `narration` | The name should be shown when the account details are fetched.                                  |
| `tx_ref`    | The transaction reference that should be returned whenever a transfer is made into the account. |

Additionally, you can [create virtual accounts in bulk](/v3.0.0/reference/create-bulk-virtual-account-numbers) and [retrieve](/v3.0.0/reference/get-bulk-virtual-account-details) their details at any time. For more details, see the [API reference](/v3.0.0/reference/create-a-virtual-account-number-1).

On a successful request, you'll get a response similar to this:

```json 200 Ok
{
    "status": "success",
    "message": "Virtual account created",
    "data": {
        "response_code": "02",
        "response_message": "Transaction in progress",
        "flw_ref": "NDKZ8600178111021323728832",
        "order_ref": "URF_1781110210729_7253035",
        "account_number": "9587478607",
        "bank_name": "Flutterwave MFB",
        "created_at": "2026-06-10 17:50:13",
        "expiry_date": "N/A",
        "note": "Please make a bank transfer to Tester FLW",
        "amount": "0.00"
    }
}
```

<br />

> 🚧 Handling Underpayments and Overpayments
>
> When customers pay less than the transaction amount to the virtual account, the transfer is automatically reversed. If they paid more than the transaction amount, the extra amount is reversed after the processing the transaction amount.

# Virtual Account Webhooks

Whenever a transfer is made to the virtual account, we'll send you a webhook that looks like this:

```json Webhook Structure
{
  "event": "charge.completed",
  "data": {
    "id": 2028146660,
    "tx_ref": "UNIQUE_TRANChgTdlIfONff_REFERENCE",
    "flw_ref": "100004260420103413157701995493",
    "device_fingerprint": "N/A",
    "amount": 100,
    "currency": "NGN",
    "charged_amount": 102,
    "app_fee": 2,
    "merchant_fee": 0,
    "processor_response": "success",
    "auth_model": "AUTH",
    "ip": "::ffff:54.154.184.168",
    "narration": "FOR TESTING PURPOSE",
    "status": "successful",
    "payment_type": "bank_transfer",
    "created_at": "2026-04-20T10:34:22.000Z",
    "account_id": 96753,
    "customer": {
      "id": 1334422040,
      "name": "Flutterwave Developers",
      "phone_number": "08012345678",
      "email": "developers@flutterwavego.com",
      "created_at": "2026-04-16T21:31:36.000Z"
    }
  },
  "meta_data": {
    "originatorname": "ADEDOTUN OBATOMI",
    "bankname": "OPAY",
    "bankcode": "100004",
    "originatoramount": "N/A",
    "originatoraccountnumber": "813*******00"
  },
  "event.type": "BANK_TRANSFER_TRANSACTION"
}
```

> 📘 **How to Retrieve the Session ID.**
>
> The `session_id` used to reconcile transactions is returned in webhooks as the `flw_ref`. Store this value in your database alongside your internal transaction records.

Now, your webhook handler can handle the event and credit the customer's wallet. For help setting up webhooks, see our guide on [webhooks](/v3.0.0/docs/webhooks).

# Creating Bulk Virtual Accounts.

You can generate bulk static virtual accounts for your customers with just a single request. This is important if you’re managing a large customer base or need to streamline payment collections.

To create bulk virtual accounts, make a `POST` request to the [bulk virtual account endpoint](/v3.0.0/reference/create-bulk-virtual-account-numbers) with the following parameters:

* `batch_ref`: A unique reference to identify the current batch.
* `narration` (optional): Provides context or the reason for the request.
* `bulk_data`: A list containing virtual account details for each customer. Each entry should include:
* `firstname`: Customer’s first name.
* `lastname`: Customer’s last name.
* `email`: Customer’s email address.
* `bvn` or `nin`: Customer’s Bank Verification Number or National Identification Number.
* `is_permanent`: Set to `true` for a static virtual account.

```curl cURL
curl -X POST 'https://api.flutterwave.com/v3/bulk-virtual-account-numbers' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer FLWSECK_TEST-XXXXXXXXXXXXXXXXXXXXXXXXXX-X' \
--data-raw '{
    "batch_ref": "Bulk-VA-RWIESDP1",
    "narration": "Subscription Accounts 2025-01-05",
    "bulk_data": [
        {
            "bvn": "12345678912",
            "firstname": "Jane",
            "lastname": "Doe",
            "email": "jdoe@example.com",
            "is_permanent": true
        },
        {
            "bvn": "12345678912",
            "email": "johndoe@gmail.com",
            "firstname": "John",
            "lastname": "Doe",
            "is_permanent": true
        }
    ]
}
'

```

On a successful request, your response should include the following:

* `batch_id`: A unique identifier for the batch. You can use this to retrieve the generated virtual accounts.
* `response_code`: Indicates whether the request has been acknowledged. This should return the value `"02"`.
* `response_message`: Confirms that the request will be processed.

```curl Sample Response
{
    "status": "success",
    "message": "Bulk virtual accounts creation queued",
    "data": {
        "batch_id": "-RND_4651739890196713",
        "response_code": "02",
        "response_message": "Request added to Queue"
    }
}

```

To retrieve the newly created virtual accounts, pass the `batch_id` returned from the bulk request as a path parameter to the [get bulk account endpoint](/v3.0.0/reference/get-bulk-virtual-account-details).

```curl cURL
curl -X GET 'https://api.flutterwave.com/v3/bulk-virtual-account-numbers/-RND_4651739890196713' \
--header 'Authorization: ••••••'

```

You'll get a response similar to this:

```json Sample Response
{
    "status": "success",
    "message": "Bulk virtual accounts fetched",
    "data": {
        "virtual_accounts": [
            {
                "response_code": "02",
                "response_message": "Transaction in progress",
                "flw_ref": "NFKW801617398049775989437",
                "order_ref": "URF_1739804838924_8401035",
                "account_number": "9587478607",
                "account_status": "ACTIVE",
                "frequency": "N/A",
                "bank_name": "Flutterwave MFB",
                "created_at": "2025-02-17 16:09:37",
                "expiry_date": "N/A",
                "note": "Please make a bank transfer to Tester FLW",
                "amount": "0.00"
            },
            {
                "response_code": "02",
                "response_message": "Transaction in progress",
                "flw_ref": "MSAX8174173980497760559657",
                "order_ref": "URF_1739804838924_398835",
                "account_number": "9560077863",
                "account_status": "ACTIVE",
                "frequency": "N/A",
                "bank_name": "Flutterwave MFB",
                "created_at": "2025-02-17 16:09:37",
                "expiry_date": "N/A",
                "note": "Please make a bank transfer to Tester FLW",
                "amount": "0.00"
            }
       ]
    }
}

```