---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Bank Transfers

Generate dynamic virtual accounts for instant payments via bank transfers. We recommend you read the method [overview](/v3.0.0/docs/bank-transfer-1) before you proceed.

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
    "/charges?type=bank_transfer": {
      "post": {
        "summary": "Bank Transfers",
        "description": "Generate dynamic virtual accounts for instant payments via bank transfers. We recommend you read the method [overview](/v3.0.0/docs/bank-transfer-1) before you proceed.",
        "operationId": "charge-via-bank-transfer",
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
                  "amount",
                  "email",
                  "currency",
                  "tx_ref"
                ],
                "properties": {
                  "amount": {
                    "type": "integer",
                    "description": "This is the amount to be charged.",
                    "default": 100,
                    "format": "int32"
                  },
                  "email": {
                    "type": "string",
                    "description": "This is the email address of the customer",
                    "default": "user@flw.com"
                  },
                  "currency": {
                    "type": "string",
                    "description": "This is the specified currency to charge in.",
                    "default": "NGN",
                    "enum": [
                      "NGN",
                      "GHS"
                    ]
                  },
                  "tx_ref": {
                    "type": "string",
                    "description": "This is a unique reference, unique to the particular transaction being carried out.",
                    "default": "MC-MC-1585230ew9v5050e8"
                  },
                  "fullname": {
                    "type": "string",
                    "description": "This is the customers full name. It should include first and last name of the customer.",
                    "default": "Yemi Desola"
                  },
                  "phone_number": {
                    "type": "string",
                    "description": "This is the phone number linked to the customer's mobile money account",
                    "default": "07033002245"
                  },
                  "client_ip": {
                    "type": "string",
                    "description": "IP - Internet Protocol. This represents the current IP address of the customer carrying out the transaction",
                    "default": "154.123.220.1"
                  },
                  "device_fingerprint": {
                    "type": "string",
                    "description": "This is the fingerprint for the device being used. It can be generated using a library on whatever platform is being used",
                    "default": "62wd23423rq324323qew1"
                  },
                  "meta": {
                    "type": "object",
                    "description": "This is used to include additional payment information",
                    "properties": {
                      "flightID": {
                        "type": "string",
                        "description": "This could be the extra information you want to pass"
                      },
                      "sideNote": {
                        "type": "string",
                        "description": "This could be any message you'd like to associate with this call"
                      }
                    }
                  },
                  "subaccounts": {
                    "type": "array",
                    "description": "This is an array of objects containing the subaccount IDs to split the payment into.",
                    "items": {
                      "properties": {
                        "id": {
                          "type": "string",
                          "description": "This is the unique Id returned in the call to create a subaccount as `data.subaccount_id`",
                          "default": "RS_D87A9EE339AE28BFA2AE86041C6DE70E"
                        }
                      },
                      "type": "object"
                    }
                  },
                  "narration": {
                    "type": "string",
                    "description": "This allows the developer set the name that is shown to the customer when the account is resolved to a name. It also displays in the debit narration."
                  },
                  "is_permanent": {
                    "type": "boolean",
                    "description": "This allows you to create a static account number i.e. the account number doesn't change and customers can pay into the account number multiple times.",
                    "default": false
                  },
                  "bank_code": {
                    "type": "string",
                    "description": "The bank code of the generated virtual account for the PWBT payment.",
                    "default": "090567"
                  }
                }
              },
              "examples": {
                "Sample Request Object": {
                  "value": {
                    "tx_ref": "MC-1585230950508",
                    "amount": "1500",
                    "email": "user@gmail.com",
                    "phone_number": "054709929220",
                    "currency": "NGN",
                    "client_ip": "154.123.220.1",
                    "device_fingerprint": "62wd23423rq324323qew1",
                    "subaccounts": [
                      {
                        "id": "RS_D87A9EE339AE28BFA2AE86041C6DE70E"
                      }
                    ],
                    "narration": "All star college salary for May",
                    "is_permanent": false,
                    "bank_code": "090567"
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
                  "NGN Bank Transfer": {
                    "value": "{\n   \"status\":\"success\",\n   \"message\":\"Charge initiated\",\n   \"meta\":{\n      \"authorization\":{\n         \"transfer_reference\":\"ZZSS4548178111081675127069\",\n         \"transfer_account\":\"9755152912\",\n         \"transfer_bank\":\"Flutterwave MFB\",\n         \"account_expiration\":\"2020-03-27 09:53:39\",\n         \"transfer_note\":\"Please make a bank transfer to Yemi Desola\",\n         \"transfer_amount\":1500,\n         \"mode\":\"banktransfer\"\n      }\n   }\n}"
                  },
                  "GHS Bank Transfer": {
                    "value": "{\n  \"status\": \"success\",\n  \"message\": \"Charge initiated\",\n  \"meta\": {\n    \"authorization\": {\n      \"transfer_reference\": \"MockFLWRef-1742534635987\",\n      \"transfer_account\": \"7003000100286\",\n      \"transfer_bank\": \"Affinity\",\n      \"account_expiration\": \"2025-03-21 6:23:56 AM\",\n      \"transfer_note\": \"Mock note\",\n      \"transfer_amount\": \"100.00\",\n      \"mode\": \"banktransfer\"\n    }\n  }\n}"
                  }
                },
                "schema": {
                  "oneOf": [
                    {
                      "title": "NGN Bank Transfer",
                      "type": "object",
                      "properties": {
                        "status": {
                          "type": "string",
                          "example": "success"
                        },
                        "message": {
                          "type": "string",
                          "example": "Charge initiated"
                        },
                        "meta": {
                          "type": "object",
                          "properties": {
                            "authorization": {
                              "type": "object",
                              "properties": {
                                "transfer_reference": {
                                  "type": "string",
                                  "example": "ZZSS4548178111081675127069"
                                },
                                "transfer_account": {
                                  "type": "string",
                                  "example": "9755152912"
                                },
                                "transfer_bank": {
                                  "type": "string",
                                  "example": "Flutterwave MFB"
                                },
                                "account_expiration": {
                                  "type": "string",
                                  "example": "2020-03-27 09:53:39"
                                },
                                "transfer_note": {
                                  "type": "string",
                                  "example": "Please make a bank transfer to Yemi Desola"
                                },
                                "transfer_amount": {
                                  "type": "integer",
                                  "example": 1500,
                                  "default": 0
                                },
                                "mode": {
                                  "type": "string",
                                  "example": "banktransfer"
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    {
                      "title": "GHS Bank Transfer",
                      "type": "object",
                      "properties": {
                        "status": {
                          "type": "string",
                          "example": "success"
                        },
                        "message": {
                          "type": "string",
                          "example": "Charge initiated"
                        },
                        "meta": {
                          "type": "object",
                          "properties": {
                            "authorization": {
                              "type": "object",
                              "properties": {
                                "transfer_reference": {
                                  "type": "string",
                                  "example": "MockFLWRef-1742534635987"
                                },
                                "transfer_account": {
                                  "type": "string",
                                  "example": "7003000100286"
                                },
                                "transfer_bank": {
                                  "type": "string",
                                  "example": "Affinity"
                                },
                                "account_expiration": {
                                  "type": "string",
                                  "example": "2025-03-21 6:23:56 AM"
                                },
                                "transfer_note": {
                                  "type": "string",
                                  "example": "Mock note"
                                },
                                "transfer_amount": {
                                  "type": "string",
                                  "example": "100.00"
                                },
                                "mode": {
                                  "type": "string",
                                  "example": "banktransfer"
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
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
  "_id": "5e36e596fe0cf5005142f849:5eaf30ef7f9cee001241ac15"
}
```