---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Authentication

Learn about supported modes and how to connect to Flutterwave.

There are two **modes** of operation on your Flutterwave account:

1. **Test Mode**: This mode does not require the use of real money and designed exclusively for testing purposes. You can simulate data to replicate real-world scenarios using our [test cards and bank accounts](/v3.0.0/docs/testing) without any financial impact. It lets you test and validate your integration before going live.

2. **Live Mode**: This mode is the production environment where real money, real transactions, and real operations take place. It handles actual customer data and financial transactions. Only switch to this after you've tested your integrations thoroughly on test mode.

You can easily switch between Live and Test modes, by using the toggle button in the menu sidebar on your settings page. When you switch between modes, we'll also switch the API keys shown. Test keys will always have `_TEST` as prefix (for example, `FLWPUBK_TEST-XXXXXXXXXXXXXXXXXXXXXXXXXXX-X`)

[block:image]
{
  "images": [
    {
      "image": [
        "https://files.readme.io/e7a64beff39d99733ea8a5b5a963ba8ab483365cc1a94c385abcb7393c671ae8-apikey.png",
        "",
        ""
      ],
      "align": "center"
    }
  ]
}
[/block]

## Get your API Keys

When you create a Flutterwave account, you receive three types of API keys:

1. **Secret key**: Grants full access to your account. Use it only in secure server-side environments. **Never expose it publicly**.

2. **Public key**: Safe for client-side use (e.g., [Flutterwave Inline](/v3.0.0/docs/inline)).

3. **Encryption key**: Required for encrypting payloads when using the [direct card charge endpoints](/v3.0.0/docs/direct-card-charge). See the [encryption guide](/v3.0.0/docs/encryption-2) for more details.

Your API keys are essential for authenticating requests to our servers. To get your API keys:

1. Log into your [Flutterwave account](https://app.flutterwave.com/login)
2. Go to your [dashboard](https://app.flutterwave.com/dashboard/home).
3. Navigate to **Settings**
4. Select the **API Keys** menu under the `DEVELOPERS` section and copy your keys.

[block:image]
{
  "images": [
    {
      "image": [
        "https://files.readme.io/5640574ff3dd9abe8b933f8499dbc3b6a479961b4cc9a5776f84a4192d58ed3a-test-keys-max.png",
        "",
        ""
      ],
      "align": "center"
    }
  ]
}
[/block]

In the live environment, API key management is slightly different. To enhance the security of your live transactions, we mask the keys to prevent unauthorized access.

> ❗️ Don't Take Any Chances
>
> If you think your keys may have been compromised (for instance, you accidentally committed them to Git), you should immediately generate new ones using the **Generate new keys** button on the **Settings > API** page on your dashboard.
>
> This will invalidate all existing keys and give you a new set, and you can then update your app to use the new ones.

## Authorizing API calls

All API calls on Flutterwave are protected by default. Any API requests made without proper authorization will result in the status code **401: Unauthorized**.

> 🚧 Safeguard your API Key
>
> Your secret key can perform any actions on your Flutterwave account without restriction. It should be kept confidential and only stored on your servers, preferably as an environment variable.
>
> It should **not** be included in your Git repository or front-end JavaScript code.

To authorize API calls from your server, pass your secret key as a bearer token. This means passing an Authorization header with a value of `Bearer: YOUR_SECRET_KEY`.

For example, an API call in Node.js would look like the following:

```javascript javascript
const response = await fetch("https://api.flutterwave.com/v3/payments", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    // Your payload
  }),
});
const body = await response.json();
```

If you're using one of our [backend SDKs](/v3.0.0/docs/directory), you don't need to pass the header manually; instead, you'll provide your keys when initializing the library.

```javascript Node.js
// Install with: npm i flutterwave-node-v3
const Flutterwave = require("flutterwave-node-v3");

const flw = new Flutterwave(
  process.env.FLW_PUBLIC_KEY,
  process.env.FLW_SECRET_KEY
);

// Subsequent calls will automatically have the header added
flw.Misc.bvn({ bvn: "22222223883" }).then((response) => console.log(response));
```
```ruby Ruby
# Install with: gem install flutterwave_sdk
require "flutterwave_sdk"

flw = Flutterwave.new(ENV["FLW_PUBLIC_KEY"], ENV["FLW_SECRET_KEY"], ENV["FLW_ENCRYPTION_KEY"])

# Subsequent calls will automatically have the header added
misc = Misc.new(flw)
response = misc.resolve_bvn "22222223883"
```
```php PHP
<?php
declare(strict_types=1);

// Install with: composer require flutterwavedev/flutterwave-v3
require __DIR__ . '/vendor/autoload.php';

use Flutterwave\Flutterwave;
use Flutterwave\Helper\Config;
use Flutterwave\Service\Misc;

// By default the package reads the Flutterwave environment variables.
// You can also pass them explicitly:
$config = Config::setUp(
    (string) getenv('FLW_SECRET_KEY'),
    (string) getenv('FLW_PUBLIC_KEY'),
    (string) getenv('FLW_ENCRYPTION_KEY'),
    'staging' // or 'production'
);

Flutterwave::bootstrap($config);

$service = new Misc();
$response = $service->resolveBvn('22222223883');
print_r($response);
```