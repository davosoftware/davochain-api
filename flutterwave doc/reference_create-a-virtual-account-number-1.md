---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Create a virtual account number

Create a Virtual Account for Your Customer.

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
    "/virtual-account-numbers": {
      "post": {
        "summary": "Create a virtual account number",
        "description": "Create a Virtual Account for Your Customer.",
        "operationId": "create-a-virtual-account-number-1",
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
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "email",
                  "amount"
                ],
                "properties": {
                  "email": {
                    "type": "string",
                    "description": "The email address of the customer.",
                    "default": "user@example.com"
                  },
                  "currency": {
                    "type": "string",
                    "description": "The currency of the Virtual Account. Defaults to NGN if not passed.",
                    "default": "NGN",
                    "enum": [
                      "NGN",
                      "GHS"
                    ]
                  },
                  "amount": {
                    "type": "integer",
                    "description": "The desired amount to be collected. Required when creating a dynamic virtual account.",
                    "default": 2000,
                    "format": "int32"
                  },
                  "firstname": {
                    "type": "string",
                    "description": "This is the first name associated with the customer's account.",
                    "default": "John"
                  },
                  "lastname": {
                    "type": "string",
                    "description": "This is the last name associated with the customer's account.",
                    "default": "Doe"
                  },
                  "tx_ref": {
                    "type": "string",
                    "description": "This is a transaction reference that would be returned each time a transfer is done to the account",
                    "default": "jhn-mdkn-10192029920"
                  },
                  "is_permanent": {
                    "type": "boolean",
                    "description": "This allows you create a static account number i.e. it doesn't expire",
                    "default": false
                  },
                  "expires": {
                    "type": "string",
                    "description": "This specifies how long a dynamic virtual account remains active, in seconds. Minimum is 60 seconds (1 minute); Maximum is 5,270,401 seconds (2 months) for NGN and 172,800 seconds (48 hours) for GHS.",
                    "default": "60"
                  },
                  "narration": {
                    "type": "string",
                    "description": "This allows you specify the name shown when the account is resolved. for GHS Account. this should be 35 characters long.",
                    "default": "Please make a bank transfer to John"
                  },
                  "bvn": {
                    "type": "string",
                    "description": "This is the customer's Bank Verification Number. This is only required when creating a static NGN virtual accounts."
                  },
                  "nin": {
                    "type": "string",
                    "description": "This is the customer’s National identification Number. It is required when creating a static virtual account. It can be used in place of the customer‘s bank verification number."
                  },
                  "phonenumber": {
                    "type": "string",
                    "description": "This is the customer's phone number.",
                    "default": "08012345678"
                  },
                  "bank_code": {
                    "type": "string",
                    "description": "The bank code for the generated virtual account.",
                    "default": "090567"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "200",
            "content": {
              "application/json": {
                "examples": {
                  "Result": {
                    "value": "{\n    \"status\": \"success\",\n    \"message\": \"Virtual account created\",\n    \"data\": {\n        \"response_code\": \"02\",\n        \"response_message\": \"Transaction in progress\",\n        \"flw_ref\": \"UAYF2045178111012980726935\",\n        \"order_ref\": \"URF_1781110128750_5918935\",\n        \"account_number\": \"9519802749\",\n        \"frequency\": \"N/A\",\n        \"bank_name\": \"Flutterwave MFB\",\n        \"created_at\": \"2026-06-10 17:48:49\",\n        \"expiry_date\": \"2026-06-10 18:48:49\",\n        \"note\": \"Please make a bank transfer to Tester FLW\",\n        \"amount\": \"102.00\"\n    }\n}"
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
                      "example": "Virtual account created"
                    },
                    "data": {
                      "type": "object",
                      "properties": {
                        "response_code": {
                          "type": "string",
                          "example": "02"
                        },
                        "response_message": {
                          "type": "string",
                          "example": "Transaction in progress"
                        },
                        "flw_ref": {
                          "type": "string",
                          "example": "UAYF2045178111012980726935"
                        },
                        "order_ref": {
                          "type": "string",
                          "example": "URF_1781110128750_5918935"
                        },
                        "account_number": {
                          "type": "string",
                          "example": "9519802749"
                        },
                        "frequency": {
                          "type": "string",
                          "example": "N/A"
                        },
                        "bank_name": {
                          "type": "string",
                          "example": "Flutterwave MFB"
                        },
                        "created_at": {
                          "type": "string",
                          "example": "2026-06-10 17:48:49"
                        },
                        "expiry_date": {
                          "type": "string",
                          "example": "2026-06-10 18:48:49"
                        },
                        "note": {
                          "type": "string",
                          "example": "Please make a bank transfer to Tester FLW"
                        },
                        "amount": {
                          "type": "string",
                          "example": "102.00"
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
  "_id": "5e36e596fe0cf5005142f849:5e3ab7f324946100183bef5a"
}
```