Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Creating an Internal Withdrawal from a Sub-Account to the Main Account on Quidax

## Overview

This guide explains how to create an **internal withdrawal** on Quidax.

The endpoint is used to transfer funds **from a Quidax sub-account to the main account**.

It creates a withdrawal request from the sub-account specified in the URL and sends the funds to the main account identified in the request payload.

## What is an Internal Withdrawal?

An internal withdrawal is a transfer of funds between accounts within Quidax, instead of sending funds to an external wallet or bank account.

In this case, the internal withdrawal moves funds **from a sub-account to the main account**.

Because the transfer happens within Quidax, the destination is identified using an internal account ID, which is passed in the payload as `fund_uid`.

For this endpoint:

* the sender is the sub-account identified by `<sub_account_id>` in the URL
* the receiver is the main account identified by `fund_uid` in the request body
* the asset and amount are defined using `currency` and `amount`

## Endpoint

```http
POST https://openapi.quidax.io/exchange-open-api/api/v1/users/<sub_account_id>/withdraws
```

## What is `<sub_account_id>`?

`<sub_account_id>` is the unique ID of the sub-account you want to withdraw funds from.

It is passed directly in the endpoint URL:

```http
/users/<sub_account_id>/withdraws
```

For example, if the sub-account ID is:

```text
abc123
```

Then the endpoint becomes:

```http
https://openapi.quidax.io/exchange-open-api/api/v1/users/abc123/withdraws
```

This means the withdrawal will be created **from the sub-account with ID `abc123`** and the funds will be transferred to the main account specified in the payload.

## How to Fetch the Main Account ID

To transfer funds from a sub-account to the main account, you need the main account ID. This ID is used as the value of `fund_uid` in the withdrawal payload.

You can fetch the main account details using the Quidax **Fetch parent account** endpoint:

```http
GET https://openapi.quidax.io/exchange-open-api/api/v1/users/me
```

The returned parent account ID should be used as the `fund_uid` when creating the internal withdrawal.

Documentation reference:

```text
https://docs.quidax.io/v3.0/reference/fetch-master-accounts
```

## Headers

| Header          | Value              | Description                                                                               |
| --------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `Authorization` | `Bearer test_key`  | Your API authorization token. Replace `test_key` with your valid API key or access token. |
| `accept`        | `application/json` | Tells the API that you expect a JSON response.                                            |
| `content-type`  | `application/json` | Tells the API that the request body is JSON.                                              |

## Payload

```json
{
  "currency": "btc",
  "amount": "0.0000004",
  "transaction_note": "Stay safe",
  "narration": "We love you.",
  "fund_uid": "main_account_id",
  "reference": "transaction_reference"
}
```

## Payload Body Description

| Field              | Required | Description                                                                                                                                                                                                                                           |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency`         | Yes      | The currency you want to transfer from the sub-account to the main account. This should match the asset available in the sub-account wallet. Example: `btc`.                                                                                          |
| `amount`           | Yes      | The amount of the currency to withdraw from the sub-account. It is sent as a string to preserve decimal precision, especially for crypto amounts. Example: `0.0000004`.                                                                               |
| `transaction_note` | Optional | A note or description for the transaction. This can be used internally to explain the purpose of the transfer. Example: `Stay safe`.                                                                                                                  |
| `narration`        | Optional | A description or narration for the withdrawal. This can be used for user-facing or internal transaction details. Example: `We love you.`                                                                                                              |
| `fund_uid`         | Yes      | The destination account ID receiving the funds. For this use case, this should be the ID of the main account. You can get this ID by calling the Fetch parent account endpoint: `GET /exchange-open-api/api/v1/users/me`. Example: `main_account_id`. |
| `reference`        | Yes      | A unique transaction reference generated by your system. It is used to track the withdrawal, support reconciliation, prevent duplicate transactions, and match Quidax records with your internal records. Example: `transaction_reference`.           |

## Sample cURL Request

```bash
curl --request POST \
  --url https://openapi.quidax.io/exchange-open-api/api/v1/users/<sub_account_id>/withdraws \
  --header 'Authorization: Bearer test_key' \
  --header 'accept: application/json' \
  --header 'content-type: application/json' \
  --data '
{
  "currency": "btc",
  "amount": "0.0000004",
  "transaction_note": "Stay safe",
  "narration": "We love you.",
  "fund_uid": "main_account_id",
  "reference": "transaction_reference"
}'
```

## Full Example

Assume the sub-account ID is:

```text
abc123
```

The request will look like this:

```bash
curl --request POST \
  --url https://openapi.quidax.io/exchange-open-api/api/v1/users/abc123/withdraws \
  --header 'Authorization: Bearer test_key' \
  --header 'accept: application/json' \
  --header 'content-type: application/json' \
  --data '
{
  "currency": "usdt",
  "amount": "1",
  "transaction_note": "Transfer from sub-account to main account",
  "narration": "Internal withdrawal",
  "fund_uid": "main_account_id",
  "reference": "sub_to_main_usdt_001"
}'
```

## Successful API Response

When the internal withdrawal is successful, Quidax returns a response similar to this:

```json
{
  "status": "success",
  "message": "Successful",
  "data": {
    "id": "IT-014afc89bcdb4acaa9bebe943f777f15",
    "reference": "fnnnnnnnnfbbbb",
    "type": "internal_transfer",
    "currency": "usdt",
    "amount": "1.000000",
    "fee": "0.0",
    "total": "1.000000",
    "txid": null,
    "transaction_note": "Internal Crypto Transfer: We love you.",
    "narration": "We love you.",
    "status": "done",
    "reason": null,
    "created_at": "2026-06-25 23:14:33",
    "done_at": "2026-06-25 23:14:33",
    "recipient": {
      "type": "internal_transfer",
      "details": {
        "address": "johnsonoye123@gmail.com",
        "name": "Qqappstatemerchant",
        "destination_tag": "N/A"
      }
    },
    "wallet": {
      "id": "cd90ef7e33e147bda85101afaf0fb87a1777971748043",
      "name": "USDT",
      "currency": "usdt",
      "balance": "0.072246",
      "locked": "0.0",
      "staked": "0.0",
      "user": {
        "id": "b465wwri",
        "sn": "b465wwri",
        "email": "dami@gmail.com",
        "reference": null,
        "first_name": "dami",
        "last_name": "lekan",
        "display_name": null,
        "created_at": "2021-04-09T12:54:18.000Z",
        "updated_at": "2026-05-04T11:08:17.000Z"
      },
      "converted_balance": "0.072246",
      "reference_currency": "usdt",
      "is_crypto": true,
      "created_at": "2021-04-09T12:54:18.000Z",
      "updated_at": "2026-06-25T23:14:33.000Z",
      "blockchain_enabled": true,
      "default_network": "bep20",
      "networks": [
        {
          "id": "bep20",
          "name": "Binance Smart Chain",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "polygon",
          "name": "Polygon Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "trc20",
          "name": "Tron Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "erc20",
          "name": "Ethereum Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "solana",
          "name": "Solana Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "ton",
          "name": "TON Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "celo",
          "name": "CELO",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "optimism",
          "name": "OP Mainnet",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "arbitrum",
          "name": "Arbitrum One",
          "deposits_enabled": true,
          "withdraws_enabled": false
        },
        {
          "id": "lisk",
          "name": "LISK",
          "deposits_enabled": true,
          "withdraws_enabled": true
        }
      ],
      "deposit_address": "0x38e75DCa4B04447369d63D46Ef5573A523aD41FC",
      "destination_tag": null
    },
    "user": {
      "id": "b465wwri",
      "sn": "b465wwri",
      "email": "dami@gmail.com",
      "reference": null,
      "first_name": "dami",
      "last_name": "lekan",
      "display_name": null,
      "created_at": "2021-04-09T12:54:18.000Z",
      "updated_at": "2026-05-04T11:08:17.000Z"
    }
  }
}
```

The response contains the full transaction details, including the withdrawal ID, reference, currency, amount, fee, status, recipient details, wallet details, user details, supported wallet networks, and timestamps.

## Successful API Response Field Description

| Field                                      | Description                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                   | The API request status. Example: `success`.                                                                                                 |
| `message`                                  | A short message describing the result of the request. Example: `Successful`.                                                                |
| `data`                                     | The object containing the internal withdrawal transaction details.                                                                          |
| `data.id`                                  | The unique ID of the internal withdrawal transaction. Example: `IT-014afc89bcdb4acaa9bebe943f777f15`.                                       |
| `data.reference`                           | The transaction reference you provided in the request payload. This should be used to reconcile the transaction. Example: `fnnnnnnnnfbbbb`. |
| `data.type`                                | The type of withdrawal transaction. For this flow, the value is `internal_transfer`.                                                        |
| `data.currency`                            | The currency transferred. Example: `usdt`.                                                                                                  |
| `data.amount`                              | The amount transferred before fees. Example: `1.000000`.                                                                                    |
| `data.fee`                                 | The fee charged for the transfer. Example: `0.0`.                                                                                           |
| `data.total`                               | The total amount debited. This is usually the amount plus the fee. Example: `1.000000`.                                                     |
| `data.txid`                                | The blockchain transaction ID. For internal transfers, this can be `null` because the transfer happens within Quidax.                       |
| `data.transaction_note`                    | The transaction note returned for the withdrawal. Example: `Internal Crypto Transfer: We love you.`                                         |
| `data.narration`                           | The narration attached to the transaction. Example: `We love you.`                                                                          |
| `data.status`                              | The withdrawal status. Example: `done`.                                                                                                     |
| `data.reason`                              | The reason for the transaction status, if applicable. This can be `null` when the transaction is successful.                                |
| `data.created_at`                          | The date and time the withdrawal was created. Example: `2026-06-25 23:14:33`.                                                               |
| `data.done_at`                             | The date and time the withdrawal was completed. Example: `2026-06-25 23:14:33`.                                                             |
| `data.recipient`                           | The recipient details for the internal transfer.                                                                                            |
| `data.recipient.type`                      | The recipient type. For this flow, the value is `internal_transfer`.                                                                        |
| `data.recipient.details`                   | The object containing recipient details.                                                                                                    |
| `data.recipient.details.address`           | The recipient address or identifier returned by Quidax. In the sample, this is an email address.                                            |
| `data.recipient.details.name`              | The recipient name returned by Quidax.                                                                                                      |
| `data.recipient.details.destination_tag`   | The recipient destination tag, where applicable. This can be `N/A` or `null`.                                                               |
| `data.wallet`                              | The wallet that was debited for the withdrawal.                                                                                             |
| `data.wallet.id`                           | The ID of the debited wallet.                                                                                                               |
| `data.wallet.name`                         | The wallet name. Example: `USDT`.                                                                                                           |
| `data.wallet.currency`                     | The wallet currency. Example: `usdt`.                                                                                                       |
| `data.wallet.balance`                      | The wallet balance after the transfer.                                                                                                      |
| `data.wallet.locked`                       | The amount currently locked or pending.                                                                                                     |
| `data.wallet.staked`                       | The amount currently staked.                                                                                                                |
| `data.wallet.user`                         | The user object linked to the debited wallet.                                                                                               |
| `data.wallet.user.id`                      | The user account ID linked to the wallet.                                                                                                   |
| `data.wallet.user.sn`                      | The user serial number linked to the wallet.                                                                                                |
| `data.wallet.user.email`                   | The user email address linked to the wallet.                                                                                                |
| `data.wallet.user.reference`               | The user reference linked to the wallet, if available.                                                                                      |
| `data.wallet.user.first_name`              | The user’s first name linked to the wallet.                                                                                                 |
| `data.wallet.user.last_name`               | The user’s last name linked to the wallet.                                                                                                  |
| `data.wallet.user.display_name`            | The user’s display name linked to the wallet, if available.                                                                                 |
| `data.wallet.user.created_at`              | The date and time the wallet user account was created.                                                                                      |
| `data.wallet.user.updated_at`              | The date and time the wallet user account was last updated.                                                                                 |
| `data.wallet.converted_balance`            | The wallet balance converted to the reference currency.                                                                                     |
| `data.wallet.reference_currency`           | The wallet’s reference currency. Example: `usdt`.                                                                                           |
| `data.wallet.is_crypto`                    | Indicates whether the wallet is a crypto wallet. Example: `true`.                                                                           |
| `data.wallet.created_at`                   | The date and time the wallet was created.                                                                                                   |
| `data.wallet.updated_at`                   | The date and time the wallet was last updated.                                                                                              |
| `data.wallet.blockchain_enabled`           | Indicates whether blockchain features are enabled for the wallet.                                                                           |
| `data.wallet.default_network`              | The wallet’s default blockchain network. Example: `bep20`.                                                                                  |
| `data.wallet.networks`                     | The list of supported networks for the wallet, including deposit and withdrawal availability.                                               |
| `data.wallet.networks[].id`                | The network ID. Example: `bep20`, `trc20`, or `erc20`.                                                                                      |
| `data.wallet.networks[].name`              | The network name. Example: `Binance Smart Chain`.                                                                                           |
| `data.wallet.networks[].deposits_enabled`  | Shows whether deposits are enabled on the network.                                                                                          |
| `data.wallet.networks[].withdraws_enabled` | Shows whether withdrawals are enabled on the network.                                                                                       |
| `data.wallet.deposit_address`              | The wallet deposit address, where available.                                                                                                |
| `data.wallet.destination_tag`              | The wallet destination tag, where applicable.                                                                                               |
| `data.user`                                | The user account object.                                                                                                                    |
| `data.user.id`                             | The user account ID.                                                                                                                        |
| `data.user.sn`                             | The user serial number.                                                                                                                     |
| `data.user.email`                          | The user email address.                                                                                                                     |
| `data.user.reference`                      | The user reference, if available.                                                                                                           |
| `data.user.first_name`                     | The user’s first name.                                                                                                                      |
| `data.user.last_name`                      | The user’s last name.                                                                                                                       |
| `data.user.display_name`                   | The user’s display name, if available.                                                                                                      |
| `data.user.created_at`                     | The date and time the user account was created.                                                                                             |
| `data.user.updated_at`                     | The date and time the user account was last updated.                                                                                        |

## Webhook Events

After a withdrawal is processed, Quidax can send a webhook event to your configured webhook URL.

Your system should listen for both successful and failed withdrawal events.

| Event                 | Meaning                                             | Action                                                                                                  |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `withdraw.successful` | The internal withdrawal was completed successfully. | Mark the transaction as successful or completed in your system.                                         |
| `withdraw.rejected`   | The internal withdrawal failed or was rejected.     | Mark the transaction as failed or rejected in your system and review the rejection reason, if provided. |

Successful withdrawal webhook documentation reference:

```text
https://docs.quidax.io/v3.0/docs/withdraw-successful
```

Failed withdrawal webhook documentation reference:

```text
https://docs.quidax.io/v3.0/docs/withdraw-rejected
```

## Sample Successful Webhook Payload

The successful webhook event name is:

```text
withdraw.successful
```

Sample payload:

```json
{
  "event": "withdraw.successful",
  "data": {
    "id": "IT-014afc89bcdb4acaa9bebe943f777f15",
    "reference": "fnnnnnnnnfbbbb",
    "type": "internal_transfer",
    "currency": "usdt",
    "amount": "1.000000",
    "fee": "0.0",
    "total": "1.000000",
    "txid": null,
    "transaction_note": "Internal Crypto Transfer: We love you.",
    "narration": "We love you.",
    "status": "done",
    "reason": null,
    "created_at": "2026-06-25 23:14:33",
    "done_at": "2026-06-25 23:14:33",
    "recipient": {
      "type": "internal_transfer",
      "details": {
        "address": "testuser@gmail.com",
        "name": "Qqappstatemerchant",
        "destination_tag": "N/A"
      }
    },
    "wallet": {
      "id": "cd90ef7e33e147bda85101afaf0fb87a1777971748043",
      "name": "USDT",
      "currency": "usdt",
      "balance": "0.072246",
      "locked": "0.0",
      "staked": "0.0",
      "user": {
        "id": "b465wwri",
        "sn": "b465wwri",
        "email": "dami@gmail.com",
        "reference": null,
        "first_name": "dami",
        "last_name": "lekan",
        "display_name": null,
        "created_at": "2021-04-09T12:54:18.000Z",
        "updated_at": "2026-05-04T11:08:17.000Z"
      },
      "converted_balance": "0.072246",
      "reference_currency": "usdt",
      "is_crypto": true,
      "created_at": "2021-04-09T12:54:18.000Z",
      "updated_at": "2026-06-25T23:14:33.000Z",
      "blockchain_enabled": true,
      "default_network": "bep20",
      "networks": [
        {
          "id": "bep20",
          "name": "Binance Smart Chain",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "polygon",
          "name": "Polygon Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "trc20",
          "name": "Tron Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "erc20",
          "name": "Ethereum Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "solana",
          "name": "Solana Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "ton",
          "name": "TON Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "celo",
          "name": "CELO",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "optimism",
          "name": "OP Mainnet",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "arbitrum",
          "name": "Arbitrum One",
          "deposits_enabled": true,
          "withdraws_enabled": false
        },
        {
          "id": "lisk",
          "name": "LISK",
          "deposits_enabled": true,
          "withdraws_enabled": true
        }
      ],
      "deposit_address": "0x38e75DCa4B04447369d63D46Ef5573A523aD41FC",
      "destination_tag": null
    },
    "user": {
      "id": "b465wwri",
      "sn": "b465wwri",
      "email": "dami@gmail.com",
      "reference": null,
      "first_name": "dami",
      "last_name": "lekan",
      "display_name": null,
      "created_at": "2021-04-09T12:54:18.000Z",
      "updated_at": "2026-05-04T11:08:17.000Z"
    }
  }
}
```

## Failed Withdrawal Webhook

If the withdrawal fails or is rejected, Quidax can send a failed withdrawal webhook to your configured webhook URL.

The failed withdrawal event name is:

**withdraw\.rejected**

The failed withdrawal webhook follows the same general structure as the successful withdrawal webhook, but the `event` value will be `withdraw.rejected`, and the transaction status and reason should be used to determine why the withdrawal failed.

Documentation reference

<https://docs.quidax.io/v3.0/docs/withdraw-rejected>

## Sample Failed Webhook Payload

```json
{
  "event": "withdraw.rejected",
  "data": {
    "id": "IT-014afc89bcdb4acaa9bebe943f777f15",
    "reference": "fnnnnnnnnfbbbb",
    "type": "internal_transfer",
    "currency": "usdt",
    "amount": "1.000000",
    "fee": "0.0",
    "total": "1.000000",
    "txid": null,
    "transaction_note": "Internal Crypto Transfer: We love you.",
    "narration": "We love you.",
    "status": "rejected",
    "reason": "Withdrawal rejected",
    "created_at": "2026-06-25 23:14:33",
    "done_at": null,
    "recipient": {
      "type": "internal_transfer",
      "details": {
        "address": "johnsonoye123@gmail.com",
        "name": "Qqappstatemerchant",
        "destination_tag": "N/A"
      }
    },
    "wallet": {
      "id": "cd90ef7e33e147bda85101afaf0fb87a1777971748043",
      "name": "USDT",
      "currency": "usdt",
      "balance": "0.072246",
      "locked": "0.0",
      "staked": "0.0",
      "user": {
        "id": "b465wwri",
        "sn": "b465wwri",
        "email": "dami@gmail.com",
        "reference": null,
        "first_name": "dami",
        "last_name": "lekan",
        "display_name": null,
        "created_at": "2021-04-09T12:54:18.000Z",
        "updated_at": "2026-05-04T11:08:17.000Z"
      },
      "converted_balance": "0.072246",
      "reference_currency": "usdt",
      "is_crypto": true,
      "created_at": "2021-04-09T12:54:18.000Z",
      "updated_at": "2026-06-25T23:14:33.000Z",
      "blockchain_enabled": true,
      "default_network": "bep20",
      "networks": [
        {
          "id": "bep20",
          "name": "Binance Smart Chain",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "polygon",
          "name": "Polygon Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "trc20",
          "name": "Tron Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "erc20",
          "name": "Ethereum Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "solana",
          "name": "Solana Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "ton",
          "name": "TON Network",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "celo",
          "name": "CELO",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "optimism",
          "name": "OP Mainnet",
          "deposits_enabled": true,
          "withdraws_enabled": true
        },
        {
          "id": "arbitrum",
          "name": "Arbitrum One",
          "deposits_enabled": true,
          "withdraws_enabled": false
        },
        {
          "id": "lisk",
          "name": "LISK",
          "deposits_enabled": true,
          "withdraws_enabled": true
        }
      ],
      "deposit_address": "0x38e75DCa4B04447369d63D46Ef5573A523aD41FC",
      "destination_tag": null
    },
    "user": {
      "id": "b465wwri",
      "sn": "b465wwri",
      "email": "dami@gmail.com",
      "reference": null,
      "first_name": "dami",
      "last_name": "lekan",
      "display_name": null,
      "created_at": "2021-04-09T12:54:18.000Z",
      "updated_at": "2026-05-04T11:08:17.000Z"
    }
  }
}
```

## Webhook Field Description

| Field                                      | Description                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`                                    | The webhook event name. Example: `withdraw.successful` or `withdraw.rejected`.                                                                    |
| `data`                                     | The object containing the withdrawal transaction details.                                                                                         |
| `data.id`                                  | The unique ID of the withdrawal transaction. Example: `IT-014afc89bcdb4acaa9bebe943f777f15`.                                                      |
| `data.reference`                           | The transaction reference sent in the original withdrawal request. Use this to match the webhook to the transaction in your system.               |
| `data.type`                                | The withdrawal type. For this internal withdrawal flow, the value is `internal_transfer`.                                                         |
| `data.currency`                            | The currency withdrawn. Example: `usdt`.                                                                                                          |
| `data.amount`                              | The amount withdrawn before fees. Example: `1.000000`.                                                                                            |
| `data.fee`                                 | The fee charged for the withdrawal. Example: `0.0`.                                                                                               |
| `data.total`                               | The total amount debited for the withdrawal. Example: `1.000000`.                                                                                 |
| `data.txid`                                | The blockchain transaction ID. For internal transfers, this can be `null`.                                                                        |
| `data.transaction_note`                    | The transaction note returned for the withdrawal.                                                                                                 |
| `data.narration`                           | The narration attached to the withdrawal.                                                                                                         |
| `data.status`                              | The final withdrawal status. Example: `done` for successful withdrawals or `rejected` for failed withdrawals.                                     |
| `data.reason`                              | The reason for the withdrawal status, if any. This can be `null` for successful withdrawals or contain a rejection reason for failed withdrawals. |
| `data.created_at`                          | The date and time the withdrawal was created.                                                                                                     |
| `data.done_at`                             | The date and time the withdrawal was completed. This can be `null` if the withdrawal was rejected before completion.                              |
| `data.recipient`                           | The recipient object for the transfer.                                                                                                            |
| `data.recipient.type`                      | The recipient type. For this flow, the value is `internal_transfer`.                                                                              |
| `data.recipient.details`                   | The object containing recipient details.                                                                                                          |
| `data.recipient.details.address`           | The recipient address or identifier returned by Quidax. In the sample, this is an email address.                                                  |
| `data.recipient.details.name`              | The recipient name returned by Quidax.                                                                                                            |
| `data.recipient.details.destination_tag`   | The recipient destination tag, where applicable. This can be `N/A` or `null`.                                                                     |
| `data.wallet`                              | The debited wallet object.                                                                                                                        |
| `data.wallet.id`                           | The ID of the debited wallet.                                                                                                                     |
| `data.wallet.name`                         | The wallet name. Example: `USDT`.                                                                                                                 |
| `data.wallet.currency`                     | The wallet currency. Example: `usdt`.                                                                                                             |
| `data.wallet.balance`                      | The wallet balance after the transfer.                                                                                                            |
| `data.wallet.locked`                       | The amount currently locked or pending.                                                                                                           |
| `data.wallet.staked`                       | The amount currently staked.                                                                                                                      |
| `data.wallet.user`                         | The user object linked to the debited wallet.                                                                                                     |
| `data.wallet.user.id`                      | The user account ID linked to the wallet.                                                                                                         |
| `data.wallet.user.sn`                      | The user serial number linked to the wallet.                                                                                                      |
| `data.wallet.user.email`                   | The user email address linked to the wallet.                                                                                                      |
| `data.wallet.user.reference`               | The user reference linked to the wallet, if available.                                                                                            |
| `data.wallet.user.first_name`              | The user’s first name linked to the wallet.                                                                                                       |
| `data.wallet.user.last_name`               | The user’s last name linked to the wallet.                                                                                                        |
| `data.wallet.user.display_name`            | The user’s display name linked to the wallet, if available.                                                                                       |
| `data.wallet.user.created_at`              | The date and time the wallet user account was created.                                                                                            |
| `data.wallet.user.updated_at`              | The date and time the wallet user account was last updated.                                                                                       |
| `data.wallet.converted_balance`            | The wallet balance converted to the reference currency.                                                                                           |
| `data.wallet.reference_currency`           | The wallet’s reference currency. Example: `usdt`.                                                                                                 |
| `data.wallet.is_crypto`                    | Indicates whether the wallet is a crypto wallet. Example: `true`.                                                                                 |
| `data.wallet.created_at`                   | The date and time the wallet was created.                                                                                                         |
| `data.wallet.updated_at`                   | The date and time the wallet was last updated.                                                                                                    |
| `data.wallet.blockchain_enabled`           | Indicates whether blockchain features are enabled for the wallet.                                                                                 |
| `data.wallet.default_network`              | The wallet’s default blockchain network. Example: `bep20`.                                                                                        |
| `data.wallet.networks`                     | The list of supported networks for the wallet, including deposit and withdrawal availability.                                                     |
| `data.wallet.networks[].id`                | The network ID. Example: `bep20`, `trc20`, or `erc20`.                                                                                            |
| `data.wallet.networks[].name`              | The network name. Example: `Binance Smart Chain`.                                                                                                 |
| `data.wallet.networks[].deposits_enabled`  | Shows whether deposits are enabled on the network.                                                                                                |
| `data.wallet.networks[].withdraws_enabled` | Shows whether withdrawals are enabled on the network.                                                                                             |
| `data.wallet.deposit_address`              | The wallet deposit address, where available.                                                                                                      |
| `data.wallet.destination_tag`              | The wallet destination tag, where applicable.                                                                                                     |
| `data.user`                                | The user account object.                                                                                                                          |
| `data.user.id`                             | The user account ID.                                                                                                                              |
| `data.user.sn`                             | The user serial number.                                                                                                                           |
| `data.user.email`                          | The user email address.                                                                                                                           |
| `data.user.reference`                      | The user reference, if available.                                                                                                                 |
| `data.user.first_name`                     | The user’s first name.                                                                                                                            |
| `data.user.last_name`                      | The user’s last name.                                                                                                                             |
| `data.user.display_name`                   | The user’s display name, if available.                                                                                                            |
| `data.user.created_at`                     | The date and time the user account was created.                                                                                                   |
| `data.user.updated_at`                     | The date and time the user account was last updated.                                                                                              |

## How to Reconcile the API Response and Webhook

Use the `reference` field to match the API response with the webhook event.

For example, if you create the withdrawal with this reference:

```json
{
  "reference": "sub_to_main_usdt_001"
}
```

Then the same reference should be checked in:

```text
data.reference
```

in the API response and in the webhook payload.

This allows your system to confirm that the webhook belongs to the same withdrawal request that was created earlier.

Your system should check that:

* `event` is either `withdraw.successful` or `withdraw.rejected`
* `data.reference` matches the transaction reference generated by your system
* `data.id` matches the Quidax withdrawal transaction ID, where available
* `data.status` shows the final status of the withdrawal
* `data.reason` is reviewed when the withdrawal is rejected

## Handling Successful and Failed Webhooks

When your system receives a webhook, process it based on the event name.

### If `event` is `withdraw.successful`

This means the withdrawal was completed successfully.

Your system should:

* confirm that `data.status` is `done`
* match `data.reference` with your internal transaction record
* mark the internal transaction as successful or completed
* store the Quidax withdrawal ID from `data.id`
* store the completion time from `data.done_at`

### If `event` is `withdraw.rejected`

This means the withdrawal failed or was rejected.

Your system should:

* match `data.reference` with your internal transaction record
* mark the internal transaction as failed or rejected
* store the Quidax withdrawal ID from `data.id`
* check `data.reason`, where available, to understand why the withdrawal failed
* avoid crediting the transaction as successful

## How the Transfer Works

1. The API reads the `<sub_account_id>` from the URL.
2. Quidax creates a withdrawal from that sub-account.
3. The `currency` and `amount` determine the asset and quantity to transfer.
4. The `fund_uid` identifies the main account that should receive the funds.
5. The `reference` is used to uniquely identify and track the transaction.
6. Once the withdrawal is processed, Quidax sends a webhook event.
7. If the withdrawal is successful, Quidax sends `withdraw.successful`.
8. If the withdrawal is rejected or fails, Quidax sends `withdraw.rejected`.
9. Your system should use `data.reference` or `data.id` to update the transaction status.

## Important Notes

Make sure the sub-account has enough balance before creating the withdrawal.

Make sure `<sub_account_id>` is the correct ID of the sub-account you want to withdraw from.

Make sure `fund_uid` is the correct main account ID that should receive the funds.

You can fetch the main account ID using the Fetch parent account endpoint:

```http
GET https://openapi.quidax.io/exchange-open-api/api/v1/users/me
```

Always generate a unique `reference` for every transaction.

Do not reuse the same `reference` for multiple withdrawals.

Listen for both `withdraw.successful` and `withdraw.rejected` webhook events.

Use `withdraw.successful` to confirm completed transfers.

Use `withdraw.rejected` to detect failed or rejected transfers.

For rejected withdrawals, check `data.reason`, where available, to understand why the withdrawal failed.

Use the webhook `event` value to confirm the webhook type.

Use `data.reference` to reconcile the webhook with your internal transaction record.

Replace `test_key` with a valid authorization token before making the request.

## Summary

Use this endpoint when you want to transfer funds **from a sub-account to the main account**.

The sub-account is identified in the URL using `<sub_account_id>`, while the main account is identified in the payload using `fund_uid`.

After the transfer is processed, Quidax can send one of two webhook events:

* `withdraw.successful` if the transfer is completed successfully
* `withdraw.rejected` if the transfer fails or is rejected

Your system should use the `reference` field to reconcile the API response and webhook with your internal transaction record.