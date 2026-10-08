---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Retrieve Wallet balances

Query the balances for your wallet in all currencies.

# OpenAPI definition

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "Flutterwave v3",
    "version": "3.0.0"
  },
  "servers": [
    {
      "url": "https://api.flutterwave.com/v3"
    }
  ],
  "security": [
    {}
  ],
  "paths": {
    "/balances": {
      "get": {
        "summary": "Retrieve Wallet balances",
        "description": "Query the balances for your wallet in all currencies.",
        "operationId": "get-all-wallet-balances",
        "parameters": [
          {
            "name": "Authorization",
            "in": "header",
            "description": "Pass your secret key as a bearer token in the request header to authorize this call",
            "required": true,
            "schema": {
              "type": "string",
              "default": "Bearer FLWSECK_TEST-SANDBOXDEMOKEY-X"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "200",
            "content": {
              "application/json": {
                "examples": {
                  "Result": {
                    "value": "{\n  \"status\": \"success\",\n  \"message\": \"Wallet balances fetched\",\n  \"data\": [\n    {\n      \"currency\": \"NGN\",\n      \"available_balance\": 2367840,\n      \"ledger_balance\": 253125.82\n    },\n    {\n      \"currency\": \"KES\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 1226.72\n    },\n    {\n      \"currency\": \"GHS\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"USD\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 472.08\n    },\n    {\n      \"currency\": \"EUR\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"ZAR\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"GBP\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"TZS\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"UGX\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"RWF\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 5000\n    },\n    {\n      \"currency\": \"ZMW\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"INR\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"XOF\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"MUR\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    },\n    {\n      \"currency\": \"ETB\",\n      \"available_balance\": 0,\n      \"ledger_balance\": 0\n    }\n  ]\n}"
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {
                    "status": {
                      "type": "string",
                      "example": "success"
                    },
                    "message": {
                      "type": "string",
                      "example": "Wallet balances fetched"
                    },
                    "data": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "currency": {
                            "type": "string",
                            "example": "NGN"
                          },
                          "available_balance": {
                            "type": "integer",
                            "example": 2367840,
                            "default": 0
                          },
                          "ledger_balance": {
                            "type": "number",
                            "example": 253125.82,
                            "default": 0
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "400",
            "content": {
              "application/json": {
                "examples": {
                  "Result": {
                    "value": "{}"
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {}
                }
              }
            }
          }
        },
        "deprecated": false
      }
    }
  },
  "x-readme": {
    "headers": [
      {
        "key": "Content-Type",
        "value": "application/json"
      }
    ],
    "explorer-enabled": true,
    "proxy-enabled": true
  },
  "x-readme-fauxas": true,
  "_id": "5e36e596fe0cf5005142f849:5e38474690c7f10045087c03"
}
```