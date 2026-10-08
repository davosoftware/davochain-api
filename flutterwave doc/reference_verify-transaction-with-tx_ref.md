---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Verify transaction status with reference

Verify transactions using the Merchant's transaction reference.

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
    "/transactions/verify_by_reference": {
      "get": {
        "summary": "Verify transaction status with reference",
        "description": "Verify transactions using the Merchant's transaction reference.",
        "operationId": "verify-transaction-with-tx_ref",
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
          },
          {
            "name": "tx_ref",
            "in": "query",
            "description": "This is a unique reference peculiar to the transaction that was carried out.",
            "schema": {
              "type": "string",
              "default": "DevRef002156"
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
                    "value": "{\n    \"status\": \"success\",\n    \"message\": \"Transaction fetched successfully\",\n    \"data\": {\n        \"id\": 3091255,\n        \"tx_ref\": \"DevRef002156\",\n        \"flw_ref\": \"FLW-MOCK-628ab72b8c2f748015e99ef9428077ef\",\n        \"device_fingerprint\": \"N/A\",\n        \"amount\": 1000,\n        \"currency\": \"NGN\",\n        \"charged_amount\": 1000,\n        \"app_fee\": 14,\n        \"merchant_fee\": 0,\n        \"processor_response\": \"successful\",\n        \"auth_model\": \"PIN\",\n        \"ip\": \"52.209.154.143\",\n        \"narration\": \"CARD Transaction \",\n        \"status\": \"successful\",\n        \"payment_type\": \"card\",\n        \"created_at\": \"2022-02-01T10:28:27.000Z\",\n        \"account_id\": 20937,\n        \"card\": {\n            \"first_6digits\": \"553188\",\n            \"last_4digits\": \"2950\",\n            \"issuer\": \" CREDIT\",\n            \"country\": \"NIGERIA NG\",\n            \"type\": \"MASTERCARD\",\n            \"token\": \"flw-t1nf-2ce34f257402019c5e3976845185afca-m03k\",\n            \"expiry\": \"09/32\"\n        },\n        \"meta\": null,\n        \"amount_settled\": 986,\n        \"customer\": {\n            \"id\": 1507191,\n            \"name\": \"Flutterwave Developers\",\n            \"phone_number\": \"N/A\",\n            \"email\": \"developers@flutterwavego.com\",\n            \"created_at\": \"2022-02-01T10:28:27.000Z\"\n        }\n    }\n}"
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
                      "example": "Transaction fetched successfully"
                    },
                    "data": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "example": 3091255,
                          "default": 0
                        },
                        "tx_ref": {
                          "type": "string",
                          "example": "DevRef002156"
                        },
                        "flw_ref": {
                          "type": "string",
                          "example": "FLW-MOCK-628ab72b8c2f748015e99ef9428077ef"
                        },
                        "device_fingerprint": {
                          "type": "string",
                          "example": "N/A"
                        },
                        "amount": {
                          "type": "integer",
                          "example": 1000,
                          "default": 0
                        },
                        "currency": {
                          "type": "string",
                          "example": "NGN"
                        },
                        "charged_amount": {
                          "type": "integer",
                          "example": 1000,
                          "default": 0
                        },
                        "app_fee": {
                          "type": "integer",
                          "example": 14,
                          "default": 0
                        },
                        "merchant_fee": {
                          "type": "integer",
                          "example": 0,
                          "default": 0
                        },
                        "processor_response": {
                          "type": "string",
                          "example": "successful"
                        },
                        "auth_model": {
                          "type": "string",
                          "example": "PIN"
                        },
                        "ip": {
                          "type": "string",
                          "example": "52.209.154.143"
                        },
                        "narration": {
                          "type": "string",
                          "example": "CARD Transaction "
                        },
                        "status": {
                          "type": "string",
                          "example": "successful"
                        },
                        "payment_type": {
                          "type": "string",
                          "example": "card"
                        },
                        "created_at": {
                          "type": "string",
                          "example": "2022-02-01T10:28:27.000Z"
                        },
                        "account_id": {
                          "type": "integer",
                          "example": 20937,
                          "default": 0
                        },
                        "card": {
                          "type": "object",
                          "properties": {
                            "first_6digits": {
                              "type": "string",
                              "example": "553188"
                            },
                            "last_4digits": {
                              "type": "string",
                              "example": "2950"
                            },
                            "issuer": {
                              "type": "string",
                              "example": " CREDIT"
                            },
                            "country": {
                              "type": "string",
                              "example": "NIGERIA NG"
                            },
                            "type": {
                              "type": "string",
                              "example": "MASTERCARD"
                            },
                            "token": {
                              "type": "string",
                              "example": "flw-t1nf-2ce34f257402019c5e3976845185afca-m03k"
                            },
                            "expiry": {
                              "type": "string",
                              "example": "09/32"
                            }
                          }
                        },
                        "meta": {},
                        "amount_settled": {
                          "type": "integer",
                          "example": 986,
                          "default": 0
                        },
                        "customer": {
                          "type": "object",
                          "properties": {
                            "id": {
                              "type": "integer",
                              "example": 1507191,
                              "default": 0
                            },
                            "name": {
                              "type": "string",
                              "example": "Flutterwave Developers"
                            },
                            "phone_number": {
                              "type": "string",
                              "example": "N/A"
                            },
                            "email": {
                              "type": "string",
                              "example": "developers@flutterwavego.com"
                            },
                            "created_at": {
                              "type": "string",
                              "example": "2022-02-01T10:28:27.000Z"
                            }
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
  "_id": "5e36e596fe0cf5005142f849:61fd673934c2a90412b62843"
}
```