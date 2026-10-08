---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Virtual Accounts

Learn how to use a virtual account.

> 📘
>
> Virtual accounts(VAs) should not be confused with pay with bank transfer (PWBT). VAs are useful for more complex flow while PWBT accounts only support one-time transaction. Learn more about their differences [here](/v3.0.0/docs/virtual-account#virtual-accounts-vs-pay-with-bank-transfers).

Virtual accounts are generated account details (account number and bank) that allow Flutterwave merchants to receive payments from customers via direct bank transfer. Virtual accounts are currently only available for NGN and GHS payments.

# Virtual Accounts vs Pay with Bank Transfers

While both virtual accounts (VAs) and pay with bank transfers (PWBTs) facilitate bank payments, they support different payment scenarios and levels of control.

Our Virtual account service allows you to create and manage the account details generated. With the VA service, you can create both **static** and **dynamic** accounts for different use cases, e.g., permanent accounts for funding wallet apps.

With virtual accounts, you have more control over the accounts generated. You can:

* Reuse virtual account details (static accounts).
* Generate virtual accounts in bulk.
* Update details linked to a virtual account, e.g., BVN.
* Delete an inactive virtual account.

PWBT enables you to receive payments via a temporary account, which is automatically generated for each transaction. However, you **cannot** manage the lifecycle of these accounts. For example:

* You cannot reuse account details across multiple transactions.
* You cannot update or delete the account.

This option is best suited for businesses with straightforward payment needs who want a simple, no-maintenance way to accept bank transfers.

# Supported Currencies for Virtual Accounts

Virtual Accounts are available by default to merchants in:

1. [Nigeria - NGN (Nigerian Naira)](/v3.0.0/docs/ngn-virtual-accounts)
2. [Ghana - GHS (Ghanaian Cedi)](/v3.0.0/docs/ghs-virtual-accounts)

If you're not a merchant based in one of these countries, please contact <hi@flutterwavego.com> to request access.

# Types of Virtual Accounts

Flutterwave supports two different kinds of virtual accounts:

1. Dynamic Virtual Account.
2. Static Virtual Account.

## Dynamic Virtual Accounts

Dynamic virtual accounts are temporary, single-use accounts typically created to collect payments for one-time transactions. These accounts are valid only for a short period and expire after they are used.

These accounts are ideal for scenarios where immediate payment collection is needed and the reconciliation of transactions needs to be seamless. By default, temporary account numbers expire **one (1) hour** after creation.

<br />

## Static Virtual Account

Static virtual accounts are permanent accounts. They are useful for building wallet apps where your customer needs a fixed account to fund their wallet. You can assign a unique virtual account number to each customer, which they can use to fund their wallet.

<br />

# Tracking Virtual Account Payments

Virtual account payments are usually not instant and could take some minutes before they are completed on the customer's end. It is important to put measures in place to correctly identify payments and link them to the correct accounts.

To ensure accurate payment recording and reconciliation, we recommend the following best practices:

1. Specify a unique `tx_ref` reference when [creating](/v3.0.0/docs/ngn-virtual-accounts) your virtual account.

   ```json Example Request
   curl --location 'https://api.flutterwave.com/v3/virtual-account-numbers' \
   --header 'Authorization: Bearer {{YOUR_SECRET_KEY}}' \
   --header 'Content-Type: application/json' \
   --header 'Accept: application/json' \
   --data-raw '{
       "email": "user@example.com",
       "amount": 100,
       “currency”:”NGN”,
       "bank_code":"090567",
       "tx_ref": "order_1" //This must be unique!
   }'

   ```
2. Map the account details returned in the response as `data.account_number` and `data.bank_name` to your reference.
   ```json Example Response
   {
       "status": "success",
       "message": "Virtual account created",
       "data": {
           "response_code": "02",
           "response_message": "Transaction in progress",
           "flw_ref": "JYEF3181178471763041012888",
           "order_ref": "URF_1784717629447_5331035",
           "account_number": "9135488646",//Store the account number!
           "frequency": "N/A",
           "bank_name": "Flutterwave MFB (Formerly OK MFB)",//Store the bank name!
           "created_at": "2026-07-22 11:53:50",
           "expiry_date": "2026-07-22 12:53:50",
           "note": "Please make a bank transfer to Kids Foundation",
           "amount": "102.00"
       }
   }
   ```
   <br />
3. When a payment is received, inspect the `tx_ref` and `meta_data` fields in the webhook payload. Ensure that you store the customer’s information within the `meta_data` object when initiating the payment. This allows you to reliably match the incoming payment to the correct customer and transaction by linking it with the `tx_ref` and associated virtual account details.

   ```json Example Webhook
   {
     "event": "charge.completed",
     "data": {
       "id": 9458189,
       "tx_ref": "order_1", //Look up reference in your record.
       "flw_ref": "6632744317701751287349865",
       "device_fingerprint": "N/A",
       "amount": 100,
     …
     },
     "meta_data": {
       "originatoraccountnumber": "123*******90", //Link customer information to virtual account.
       "originatorname": "JOHN DOE",
       "bankname": "Access Bank",
       "originatoramount": "N/A"
     },
     "event.type": "BANK_TRANSFER_TRANSACTION"
   }

   ```

<br />

By linking the virtual account's `tx_ref`, account number, and bank name with the customer details provided in the webhook payload, you can build a complete record of each payment. This ensures that all payments made into your virtual accounts are accurately attributed and easily traceable.

<br />

# Managing your Virtual Accounts

With this service, you can perform the following actions:

1. [Generate virtual accounts in bulk](/v3.0.0/reference/create-bulk-virtual-account-numbers).
2. Retrieve information for a [single virtual account](/v3.0.0/reference/get-a-virtual-account-detail) or [multiple virtual accounts](/v3.0.0/reference/get-bulk-virtual-account-details).
3. [Update a virtual account's BVN](/v3.0.0/reference/update-bvn).
4. [Deactivate and Reactivate a virtual account](/v3.0.0/reference/deactivate-and-reactivate-virtual-accounts).