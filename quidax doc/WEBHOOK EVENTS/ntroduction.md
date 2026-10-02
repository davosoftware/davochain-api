Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Introduction

Quidax uses Webhooks to communicate updates on transactions, incoming deposits, withdrawals, instant orders, and wallet creation, initiated with the API, and kick off additional workflows based on these events. Each time an event that you listen to occurs, Quidax submits a POST request to the designated Webhook URL with information about the event.

> 🚧 Responding to webhook requests
>
> To confirm the receipt of a webhook, your endpoint should respond with an HTTP status code of 200. Any other response codes, including 3xx codes, will be regarded as a failure. The response body and headers are not a matter of concern to us in this context.

> 🚧 Be idempotent
>
> From time to time, it's possible that we could transmit the same webhook event on multiple occasions. It's important to ensure that your event processing remains idempotent, meaning that invoking the webhook multiple times will produce an identical outcome. This precaution prevents unintentionally providing a customer with the same value multiple times.

> 🚧 Always re-query
>
> Upon receiving a webhook notification, it is advisable, whenever feasible, to make an additional API call to validate the received information and confirm its integrity before providing value to the customer.
>
> For example, in the case of a successful instant order notification, you can utilize our [instant order verification](https://docs.quidax.com/reference/fetch-detail-of-an-instant-order) endpoint to ascertain the instant order status before giving the customer value.
>
> ```typescript index.ts
> const axios = require('axios');
>
> const options = {
>   method: 'GET',
>   url: 'https://openapi.quidax.io/exchange-open-api/api/v1/users/me/instant_orders/instant_order_id',
>   headers: {
>     accept: 'application/json',
>     Authorization: 'Bearer <secret_key>'
>   }
> };
>
> axios
>   .request(options)
>   .then(function (response) {
>     console.log(response.data);
>   })
>   .catch(function (error) {
>     console.error(error);
>   });
> ```

> 🚧 Webhooks Retry
>
> * We’ll send webhooks first attempt is immediately, second attempt is a 1 minute, 3rd attempt is 30mins, 4th attempt is 1hr, 5th attempt is 24hrs. then the system would stop sending webhook.

Quidax uses Webhooks to communicate updates on transactions, incoming deposits, withdrawals, instant orders, and wallet creation, initiated with the API, and kick off additional workflows based on these events. Each time an event that you listen to occurs, Quidax submits a POST request to the designated Webhook URL with information about the event.

> 🚧 Signature Secret
>
> We highly recommend you add in your signing secret in other to confirm that every request coming to that dedicated endpoint is coming from us, and not someone trying to maliciously attack your application.

```javascript Javascript
const [timestampSection, signatureSection] = req.headers['quidax-signature'].split(',');

const [timestampPrefix, timestamp] = timestampSection.split('=');

const [signaturePrefix, signature] = signatureSection.split('=');

const requestBody = JSON.stringify(req.body);

const payload = `${timestamp}.${requestBody}`;

const created_signature = crypto.createHmac('sha256', quidax_webhook_key).update(payload).digest().toString('hex');

if (signature === created_signature) {
  // Execute program
}
```