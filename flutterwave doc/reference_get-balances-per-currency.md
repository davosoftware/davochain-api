# reference_get-balances-per-currency

OpenAPI operation extracted from developer.flutterwave.com (7 Oct 2026).

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
  "components": {
    "securitySchemes": {}
  },
  "security": [
    {}
  ],
  "paths": {
    "/balances/{currency}": {
      "get": {
        "summary": "Retrieve Wallet balance by currency",
        "description": "Query your wallet balance for a specific currency.",
        "operationId": "get-balances-per-currency",
        "parameters": [
          {
            "name": "currency",
            "in": "path",
            "description": "ISO 4217 currency code.",
            "schema": {
              "type": "string",
              "default": "NGN"
            },
            "required": true
          },
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
                    "value": "{\n  \"status\": \"success\",\n  \"message\": \"Wallet balance fetched\",\n  \"data\": {\n    \"currency\": \"NGN\",\n    \"available_balance\": 2168880,\n    \"ledger_balance\": 253125.82\n  }\n}"
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
                      "example": "Wallet balance fetched"
                    },
                    "data": {
                      "type": "object",
                      "properties": {
                        "currency": {
                          "type": "string",
                          "example": "NGN"
                        },
                        "available_balance": {
                          "type": "integer",
                          "example": 2168880,
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
  "_id": "5e36e596fe0cf5005142f849:5e384f9a4021330011222729"
}
```
