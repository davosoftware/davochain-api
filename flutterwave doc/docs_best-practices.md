---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Best Practices

Learn how to use best practices to protect your transactions.

As a developer or business looking to integrate Flutterwave to receive payments from your customers, here are some best practices to guide you through the process:

## Receiving Customer Payments

* Ensure you [verify](/v3.0.0/docs/transaction-verification-1) the details of the payment by comparing the **amount**, **currency**, **transaction reference**, etc, before you give value.

* Always implement webhooks when applicable.

* Ensure that you are not rate-limited when checking the status of a transaction. Read more about our rate limits [here](/v3.0.0/docs/rate-limit).

## Making Payments

* Ensure that transfers and virtual cards are handled asynchronously via [webhooks](/v3.0.0/docs/webhooks).

## Error Handling

* Ensure that edge cases are addressed by only providing value or rendering service on a definite response as defined by the APIs.

* Ensure errors are "caught" and general error messages are shown to users in the worst case.

## Validating webhooks

* We recommend using [Secret Hash](/v3.0.0/docs/webhooks#use-a-secret-hash) on your dashboard via **Settings > Webhooks** to verify that the webhook was sent by Flutterwave.

## Security Recommendations

### API Management

Verify that your app meets the following requirements for managing your API keys:

* API keys should not be hardcoded in the codebase.
* API calls requiring your Flutterwave Secret Key must never be initiated from the client (browser/mobile app); they should be made from the backend/server side of your application.
* API keys should be stored in environment variables or a secrets manager.

### Authentication

* Ensure a strong password policy is enforced e.g., a minimum of 8 alphanumeric characters, uppercase letters, and a special character.
* Input validation is in place during login.
* Implement controls against brute force, such as account lockouts and two-factor authentication.
* Store database credentials securely using a secrets manager, preferably.

### Cookie Management

* Ensure all app session cookies have the following attributes set:
  * Secure
  * HTTPOnly
* Upon user logout, terminate the user’s session server-side and clear any client-side session tokens to prevent them from being cached on the user’s machine.
* Any session tokens must be stored within session cookies and transported only within HTTP cookie headers.

### Session Management

* Session timeouts should be configured on the server.
* The session duration should be limited to a maximum of 10 hours, after which the user must be required to authenticate again.
* Implement an idle session timeout.
* Deny concurrent sessions.
* Ensure session tokens are generated using a Random Number Generator (RNG) cryptographic provider so it cannot be easily predictable.

### Session Termination

* An accessible button must exist to allow users to log out of the application, which ends the session on the server.
* Application sessions must be invalidated on the server side.
* Your log-out function must destroy all session tokens and render them useless.

### Handling Sensitive Information

* Securely exchange encryption keys - Ensure key exchanges are performed over a secure channel (TLS 1.2 and TLS 1.3).
* Limit the use and storage of sensitive data - Ensure sensitive data are not unnecessarily transported and stored. Where possible. Abstract identifiers can be used to reduce data exposure risk.
* Encryption of sensitive data at rest.

### Error Handling and Accountability

* Ensure to log all privileged changes.
* Log all user (customer) and administrative activities.
* Log all access to sensitive data.
* When encountering an unhandled exception, display generic messages to the end user. Do not reveal details about your application's internal state, such as database errors or app server errors.
* Store logs securely and follow international standards for log retention.

### Input and Output Forms

* All input (user and service) must be validated only on the server side in addition to any client-side validation to permit only the characters required and field length necessary.
* All output back should be encoded.
* With proper input validation and output encoding, applications should not be susceptible to cross-site scripting, either stored or reflected. This includes all headers, cookies, query strings, form fields, and hidden fields.
* Create a whitelist of acceptable characters for the application to use.
* Ensure proper validation is done for files that are uploaded.
* Use parameterized SQL queries.

### Application Server

* Ensure caching has been disabled on all your SSL pages and all other pages that contain sensitive data by using the value `no-cache` or `no-store` instead of `private` in your `Cache-Control` header.
* All OS, web server and app server security patches are up to date. New patches are applied in a commercially reasonable timeframe after they are made available by the hardware and software vendors.
* `SSL` must be configured to support only `TLS` version 1.2 or higher.
* `HTTPS` should be enforced on all pages and endpoints of your application.
* The app web server must be configured to disable the `TRACE` and other `HTTP` methods if they are not being used.

### Vulnerability and Security Assessment

Ensure your application is protected against this non-exhaustive list:

* Cross-Site Request Forgery
* Cross-site scripting reflected and stored cross-site scripting
* SQL Injection
* XML Injection