---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Rate Limit

Learn about API rate limits and how to work with them

In our constant strives to achieve and maintain 99.9999% uptime and safeguard against abuse or burst of incoming traffic. We have a working guideline to ensure you are not rate limited.

If you are rate limited, you will receive a http code `429` (Too Many Requests) response. This applies to the specific merchant account making the API call.

## Tips to Prevent Rate Limiting

1. **Webhooks**: Rather than poll perpetually, we recommend monitoring changes in a transaction's webhook status. To learn more, visit our [webhooks section](/v3.0.0/docs/webhooks).
2. **Structured polling**: Do not poll indefinitely to get the status of a transaction/transfer. Instead, call an endpoint in a structured and sparse manner or in response to an event.

## Handling Rate Limits Graceful

To gracefully handle rate limits, the best option is to look out for the http response code `429` and implement a graceful retry. The retry mechanism should have a backoff mechanism to ensure the rate limits are again not exceeded

> ❗️ Rate Limit Restriction
>
> We will impose stiffer restrictions to your requests, if we notices intentional strategies or abuse to bypass the the rate limits guidelines.