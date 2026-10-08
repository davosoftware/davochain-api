---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Common Errors

Learn more about error codes and how to resolve them.

Below is a list of possible errors you might encounter and their respective status codes:

1. Payment Errors
2. Validation Errors
3. Authorization Errors
4. Server Errors

All errors have the same response format: a `status` set to **error** and a `message` describing the error. There may also be a `data` object containing more details, for example:

```json Error
{
	"status": "error",
	"message": "merchant secret key required",
	"data": null
}
```

## Payment Errors

You are likely to have a payment error when your transaction request does not pass compliance checks or when it encounters processing issues. See the full list of errors below:

[block:embed]
{
  "url": "https://airtable.com/embed/app0K81ij4jWssnV3/shreKmXyljsYL9cE1",
  "provider": "airtable.com",
  "href": "https://airtable.com/embed/app0K81ij4jWssnV3/shreKmXyljsYL9cE1",
  "typeOfEmbed": "iframe",
  "height": "533px",
  "width": "100%"
}
[/block]

<br />

<br />

## Validation Errors

Validation errors are returned when your request fails one or more validation rules. An example of this is not parsing in the required parameters in your request; you will get a **400 Bad Request** status code.

```json 400 Bad Request
{
	"status": "error",
	"message": "Cardno is required",
	"data": null
}
```

<br />

## Authorization Errors

When you send a request without adding your secret key to authorize your API calls or you send an incorrect key, you will get a **401 Unauthorized** error.

```json 401 Unauthorized
{
	"status": "error",
	"message": "Authorization required",
	"data": null
}
```

<br />

## Server errors

You will receive a server error with the status `500 Internal Server Error` when there is an error on our end. In this case, you should retry after a while or reach out to our support.

```json 500 Server Error
{
	"error_id": "ERRNO796977608T1620310828419",
	"message": "Application error. Please contact support",
	"code": "app_error"
}
```

## Next Steps

Check out our [best practices](/v3.0.0/docs/best-practices) to avoid errors and improve your payment experience.