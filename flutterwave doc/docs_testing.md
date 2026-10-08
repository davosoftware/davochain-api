---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Testing

Learn how to test your integration.

When integrating a payment gateway, you will need to test your implementation before going live. We've got test credentials for you to test a variety of use cases and allow you to simulate both successful and failed scenarios.

> 🚧 Using Test Credentials and Mock Data
>
> These credentials and data work exclusively in [Test Mode](/v3.0.0/docs/authentication). If you require mock data to test a specific flow or feature, please contact our [support team](https://flutterwave.com/support/submit-request).

<br />

## Cards

Below are card details to use to make a mock payment. To ensure accurate testing, please select the appropriate test card based on the authorization model (PIN, 3DS, AVS, and NoAuth) required for your card transaction.

Each card triggers a specific authorization flow, essential for replicating the different [direct card charge](/v3.0.0/docs/direct-card-charge) scenarios.

> 📘 Test Mode Transaction Receipt Email Delivery
>
> In test mode, transaction receipt emails are sent to your business email, not your customers'. To send test receipts to customers, please contact support.

<br />

### Successful Payments

Here is a list of cards to simulate a successful payment.

| Type                         | Network    | Card Number         | Expiry | CVV | OTP   | PIN  |
| ---------------------------- | ---------- | ------------------- | ------ | --- | ----- | ---- |
| PIN authentication           | Mastercard | 5531886652142950    | 09/32  | 564 | 12345 | 3310 |
| 3DS authentication           | Mastercard | 5438898014560229    | 10/31  | 564 | 12345 | 3310 |
| 3DS authentication           | Visa       | 4187427415564246    | 09/32  | 828 | 12345 | 3310 |
| 3DS authentication           | Afrigo     | 5640003941605320    | 05/31  | 044 | -     | -    |
| PIN authentication           | Verve      | 5061460410120223210 | 10/31  | 780 | 12345 | 3310 |
| NoAuth                       | Verve      | 5061460166976054667 | 10/29  | 564 | -     | 3310 |
| Address Verification (AVS)   | Visa       | 4556052704172643    | 09/32  | 899 | 12345 | 3310 |
| Pre-authentication Test Card | Mastercard | 5377283645077450    | 09/31  | 789 | -     | 3310 |

### Failed Payments

Here is a list of cards to simulate a failed payment.

| Type               | Network    | Card Number      | Expiry | CVV | OTP   | PIN  |
| ------------------ | ---------- | ---------------- | ------ | --- | ----- | ---- |
| Do Not Honour      | Mastercard | 5143010522339965 | 08/32  | 276 | 12345 | 3310 |
| Card Fraudulent    | Mastercard | 5590131743294314 | 11/32  | 887 | 12345 | 3310 |
| Insufficient Funds | Mastercard | 5258585922666506 | 09/31  | 883 | 12345 | 3310 |
| Do Not Honour      | Mastercard | 5143010522339965 | 08/31  | 276 | -     | 3310 |
| Insufficient Funds | Mastercard | 5258585922666506 | 09/31  | 883 | 12345 | -    |
| Insufficient Funds | Afrigo     | 5640007065275380 | 05/31  | 044 | -     | -    |
| Incorrect PIN      | Mastercard | 5399834697894723 | 09/31  | 883 | 12345 | 3310 |

<br />

## Testing Payment on Checkout

To properly render checkout on your local environment, you'd need to route your app to `localhost:<preferred-port>` e.g. `localhost:3000`. Pointing your app to an IP address e.g. `127.0.0.1:3000` would result in errors.

Credentials are listed in the [card](#cards), and [mobile money](#mobile-money) sections to help you test your checkout integration.

## OTPs

Any OTP passed in test transactions will pass validation. However, you can use these special OTPs to mock specific error scenarios:

* WRONG OTP: `5548`
* INSUFFICIENT FUNDS: `6648`

> ℹ️ Testing Tip
>
> These special OTPs will only work (simulate failed payments) when the OTP validation happens directly in our payment modal. If you are redirected to our OTP validation page, you'll need to use one of the test cards designated for [failed payments](#failed-payments).

<br />

## Bank Accounts

### Successful Payments

Bank account details to use to mock a successful payment.

| Bank              | Account number | OTP   |
| ----------------- | -------------- | ----- |
| Access Bank (044) | 0690000031     | 12345 |
| Access Bank (044) | 0690000032     | 12345 |
| Access Bank (044) | 0690000033     | 12345 |
| Access Bank (044) | 0690000034     | 12345 |

<br />

> ℹ️ Testing Tip
>
> If you need more Access Bank test account numbers, you can keep incrementing the last digit of the test account numbers above to get new test account numbers, right up to `0690000041`.

<br />

### Blacklisted Accounts

A blacklisted account indicates that the account has been flagged due to suspicious activity or non-compliance with regulations. When an account is blacklisted, transfers to that account are blocked to safeguard users from potential risks.

Common Reasons for Blacklisting:

* Fraudulent activity (e.g., money laundering or unauthorized transactions).
* Violation of terms (e.g., using the service for prohibited activities).
* Security concerns (e.g., account compromise).
* Regulatory compliance issues (e.g., sanctions or anti-money laundering regulations).

Blocking transfers to blacklisted accounts helps ensure compliance and protect users from fraud.

#### Testing Blacklisted Accounts in Your Application

To simulate a blacklisted account and handle the expected `400` error response, you can use the following test credentials in test mode:

| Bank              | Account Number | Account Name |
| ----------------- | -------------- | ------------ |
| Access Bank (044) | 0690000036     | Bode George  |

You’ll get a response similar to this:

```json
{
   "status": "error",
   "message": "Payout was made to a blacklisted account number",
   "data": null
}
```

## Mobile Money

### Successful Payments

To mock a successful mobile money payment, you can use any mobile number and the OTP `123456`. To mock a `WAVE` transaction, you can use any mobile number.

### Failed Payments

You can make mocked failed transactions for your integration tests using any of the following numbers below. Update the country code of each number to match the code of your customer's number.

| S/N | Mobile number | Error message                    |
| --- | ------------- | -------------------------------- |
| 1.  | 233121212121  | Mocked a Failed Transaction      |
| 2.  | 233010101011  | Mocked a Failed Transaction      |
| 3.  | 121212121     | Mocked a Wave Failed Transaction |

<br />

## Testing Transfers

> 🚧 IP Whitelisting
>
> In order to conduct a successful integration test, it's important to ensure that you whitelist the IP addresses of the servers making the transfer API calls.

When testing a transfer, you can use any of our provided [test accounts](#bank-accounts). By default, such transfers will always remain in a `PENDING` state. You can force transfers to behave differently by using a special kind of transaction reference when creating the transfer.

* **To mock a successful transfer**: Make sure your reference ends with `_PMCK` (for example, `"dfs23fhr7ntg0293039_PMCK"`).
* **To mock a failed transfer**: Make sure your reference ends with `_PMCK_ST_F` (for example, `"dfs23fhr7ntg0293039_PMCK_ST_F"`).

> 📘 Testing Tip
>
> By default, the status of the mocked transfer will only be updated after 10 minutes.

* **To change the time delay**: append `DU_{minutes}` to your transaction reference.\
  For Example

  * A transfer with a `reference` of `"dfs23fhr7ntg0293039_PMCK"` will succeed after 10 minutes.

  * A transfer with a `reference` of `"dfs23fhr7ntg0293039_PMCKDU_1"` will succeed after 1 minute.

  * A transfer with a `reference` of `"dfs23fhr7ntg0293039_PMCK_ST_F"` will fail after 10 minutes.

  * A transfer with a `reference` of `"dfs23fhr7ntg0293039_PMCK_ST_FDU_1"` will fail after 1 minute.

## Capitec

Here are test credentials for simulating different scenarios. To mock a successful transaction, any value can be passed as the account number/phone number.

| Scenarios | Account Number/Phone Number |
| :-------- | :-------------------------- |
| Failed    | 0001234567                  |
| Fraud     | 1112223334                  |
| Declined  | 5555555555                  |
| Timeout   | 9876543210                  |
| Pending   | 1234567890                  |

## Bill Payments

To purchase airtime, the `customer_id` must begin with the international code (`+234`) followed by a valid Nigerian mobile operator prefix (e.g., 705, 803, 708). For a complete list of supported prefixes across MTN, Glo, Airtel, and 9Mobile, see the Nigerian [MNO Prefixes Guide](https://en.wikipedia.org/wiki/Telephone_numbers_in_Nigeria#Mobile_network_prefixes).

Use the following credentials to test your bill payment integration. These credentials are intended for testing only and are not valid in the production environment.

| Biller  | Credential Type   | Credential(customer\_id) | Item Code          | Biller Code |
| ------- | ----------------- | ------------------------ | ------------------ | :---------- |
| DSTV    | Smart card number | `0025401100`             | `CB140` or `CB141` | `BIL119`    |
| AIRTIME | Phone number      | `+2347050000000`         | `AT102`            | `BIL102`    |

<br />

## BVN Credentials

There are two main cases when verifying your customer's BVN:

* Case 1: New customer consent flow i.e. initiating the customer's content.
* Case 2: Existing consent flow i.e Fetching previous consent.

Use these mock credentials to test your integration for verifying users BVN information;

| Case | BVN         | First Name | Last Name | OTP    |
| ---- | :---------- | ---------- | --------- | ------ |
| 1    | 22222223883 | Nibby      | Certifier | 111111 |
| 2    | 22123456789 | Nibby      | Certifier | -      |