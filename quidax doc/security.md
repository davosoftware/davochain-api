Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Security

![](https://files.readme.io/3efeed5-Security.jpg)

Always use HTTPS when calling the API. Non-TLS HTTP requests cause error 301 to be returned. Using non-TLS requests can leak your authentication credentials.

### Rate Limiting

As a protection mechanism to prevent abuse of our API, we have several rate limits for different endpoints.\
For our wallet generation, POST requests to this endpoint:\
`https://openapi.quidax.io/exchange-open-api/api/v1/users/<user_id>/wallets/<currency>/addresses` are restricted to 20 requests per second.

For all other endpoints, we limit the total number of calls to 300 requests per minute\
A good way to handle limits is to queue the requests and send them in batches or build a retry mechanism around the 444 status codes when received.