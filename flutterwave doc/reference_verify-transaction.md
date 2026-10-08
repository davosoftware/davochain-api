# reference_verify-transaction

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
    "/transactions/{id}/verify": {
      "get": {
        "summary": "Verify transaction status",
        "description": "This endpoint helps developers to query the final status of a transaction. This can be used to check transactions of all payment types after they have been attempted.",
        "operationId": "verify-transaction",
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
            "name": "id",
            "in": "path",
            "description": "This is the transaction unique identifier. It is returned in the initiate transaction call as `data.id`",
            "schema": {
              "type": "integer",
              "format": "int32",
              "default": 288200108
            },
            "required": true
          }
        ],
        "responses": {
          "200": {
            "description": "200",
            "content": {
              "application/json": {
                "examples": {
                  "Result": {
                    "value": "{\n    \"status\": \"success\",\n    \"message\": \"Transaction fetched successfully\",\n    \"data\": {\n        \"id\": 288200108,\n        \"tx_ref\": \"LiveCardTest\",\n        \"flw_ref\": \"YemiDesola/FLW275407301\",\n        \"device_fingerprint\": \"N/A\",\n        \"amount\": 100,\n        \"currency\": \"NGN\",\n        \"charged_amount\": 100,\n        \"app_fee\": 1.4,\n        \"merchant_fee\": 0,\n        \"processor_response\": \"Approved by Financial Institution\",\n        \"auth_model\": \"PIN\",\n        \"ip\": \"::ffff:10.5.179.3\",\n        \"narration\": \"CARD Transaction \",\n        \"status\": \"successful\",\n        \"payment_type\": \"card\",\n        \"created_at\": \"2020-07-15T14:31:16.000Z\",\n        \"account_id\": 17321,\n        \"card\": {\n            \"first_6digits\": \"232343\",\n            \"last_4digits\": \"4567\",\n            \"issuer\": \"FIRST CITY MONUMENT BANK PLC\",\n            \"country\": \"NIGERIA NG\",\n            \"type\": \"VERVE\",\n            \"token\": \"flw-t1nf-4676a40c7ddf5f12scr432aa12d471973-k3n\",\n            \"expiry\": \"02/23\"\n        },\n        \"meta\": null,\n        \"amount_settled\": 98.6,\n        \"customer\": {\n            \"id\": 216519823,\n            \"name\": \"Yemi Desola\",\n            \"phone_number\": \"N/A\",\n            \"email\": \"user@gmail.com\",\n            \"created_at\": \"2020-07-15T14:31:15.000Z\"\n        }\n    }\n}"
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
                          "example": 288200108,
                          "default": 0
                        },
                        "tx_ref": {
                          "type": "string",
                          "example": "LiveCardTest"
                        },
                        "flw_ref": {
                          "type": "string",
                          "example": "YemiDesola/FLW275407301"
                        },
                        "device_fingerprint": {
                          "type": "string",
                          "example": "N/A"
                        },
                        "amount": {
                          "type": "integer",
                          "example": 100,
                          "default": 0
                        },
                        "currency": {
                          "type": "string",
                          "example": "NGN"
                        },
                        "charged_amount": {
                          "type": "integer",
                          "example": 100,
                          "default": 0
                        },
                        "app_fee": {
                          "type": "number",
                          "example": 1.4,
                          "default": 0
                        },
                        "merchant_fee": {
                          "type": "integer",
                          "example": 0,
                          "default": 0
                        },
                        "processor_response": {
                          "type": "string",
                          "example": "Approved by Financial Institution"
                        },
                        "auth_model": {
                          "type": "string",
                          "example": "PIN"
                        },
                        "ip": {
                          "type": "string",
                          "example": "::ffff:10.5.179.3"
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
                          "example": "2020-07-15T14:31:16.000Z"
                        },
                        "account_id": {
                          "type": "integer",
                          "example": 17321,
                          "default": 0
                        },
                        "card": {
                          "type": "object",
                          "properties": {
                            "first_6digits": {
                              "type": "string",
                              "example": "232343"
                            },
                            "last_4digits": {
                              "type": "string",
                              "example": "4567"
                            },
                            "issuer": {
                              "type": "string",
                              "example": "FIRST CITY MONUMENT BANK PLC"
                            },
                            "country": {
                              "type": "string",
                              "example": "NIGERIA NG"
                            },
                            "type": {
                              "type": "string",
                              "example": "VERVE"
                            },
                            "token": {
                              "type": "string",
                              "example": "flw-t1nf-4676a40c7ddf5f12scr432aa12d471973-k3n"
                            },
                            "expiry": {
                              "type": "string",
                              "example": "02/23"
                            }
                          }
                        },
                        "meta": {},
                        "amount_settled": {
                          "type": "number",
                          "example": 98.6,
                          "default": 0
                        },
                        "customer": {
                          "type": "object",
                          "properties": {
                            "id": {
                              "type": "integer",
                              "example": 216519823,
                              "default": 0
                            },
                            "name": {
                              "type": "string",
                              "example": "Yemi Desola"
                            },
                            "phone_number": {
                              "type": "string",
                              "example": "N/A"
                            },
                            "email": {
                              "type": "string",
                              "example": "user@gmail.com"
                            },
                            "created_at": {
                              "type": "string",
                              "example": "2020-07-15T14:31:15.000Z"
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
  "_id": "5e36e596fe0cf5005142f849:5e38027ab5b68e0036352d27"
}
```
