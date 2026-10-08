---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Get multiple transactions

This endpoint allows developers to query previously initiated transactions. You can do a single or bulk query with the endpoint depending on your use case.

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
    "/transactions": {
      "get": {
        "summary": "Get multiple transactions",
        "description": "This endpoint allows developers to query previously initiated transactions. You can do a single or bulk query with the endpoint depending on your use case.",
        "operationId": "get-all-transactions",
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
            "name": "from",
            "in": "query",
            "description": "This is the specified date to start the list from. YYYY-MM-DD",
            "required": true,
            "schema": {
              "type": "string",
              "default": "2020-01-01"
            }
          },
          {
            "name": "to",
            "in": "query",
            "description": "The is the specified end period for the search . YYYY-MM-DD",
            "required": true,
            "schema": {
              "type": "string",
              "default": "2020-01-14"
            }
          },
          {
            "name": "page",
            "in": "query",
            "description": "This is the page number to retrieve e.g. setting 1 retrieves the first page",
            "schema": {
              "type": "integer",
              "format": "int32",
              "default": 1
            }
          },
          {
            "name": "customer_email",
            "in": "query",
            "description": "This is the email of the customer who carried out a transaction. You can use this to query the transactions for a single customer.",
            "schema": {
              "type": "string",
              "default": "user@example.com"
            }
          },
          {
            "name": "status",
            "in": "query",
            "description": "This is the status for the queried transactions. Expected values for status include successful and failed.",
            "schema": {
              "type": "string",
              "default": "successful"
            }
          },
          {
            "name": "tx_ref",
            "in": "query",
            "description": "This is the unique merchant reference tied to a transaction. This should be specified when querying a specific transaction.",
            "schema": {
              "type": "string",
              "default": "new-transaction-ref"
            }
          },
          {
            "name": "customer_fullname",
            "in": "query",
            "description": "The Customer's full name.",
            "schema": {
              "type": "string",
              "default": "Yemi Desola"
            }
          },
          {
            "name": "currency",
            "in": "query",
            "description": "This is the specified currency to charge in. All currencies supported by Flutterwave can be passed here. You can check our Currency listing for more details.",
            "schema": {
              "type": "string",
              "default": "NGN"
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
                    "value": "{\n  \"status\": \"success\",\n  \"message\": \"Transactions fetched\",\n  \"meta\": {\n    \"page_info\": {\n      \"total\": 44,\n      \"current_page\": 1,\n      \"total_pages\": 5\n    }\n  },\n  \"data\": [\n    {\n      \"id\": \"989226\",\n      \"tx_ref\": \"m0ckaham-1578002686748\",\n      \"flw_ref\": \"N/A\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 1000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 1000,\n      \"app_fee\": null,\n      \"merchant_fee\": 0,\n      \"processor_response\": null,\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"pending\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T22:06:45.000Z\",\n      \"amount_settled\": null,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989223\",\n      \"tx_ref\": \"m0ckaham-1578002686748\",\n      \"flw_ref\": \"N/A\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 1000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 1000,\n      \"app_fee\": null,\n      \"merchant_fee\": 0,\n      \"processor_response\": null,\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"pending\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T22:04:57.000Z\",\n      \"amount_settled\": null,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989222\",\n      \"tx_ref\": \"m0ckaham-1578002611018\",\n      \"flw_ref\": \"N/A\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 1000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 1000,\n      \"app_fee\": null,\n      \"merchant_fee\": 0,\n      \"processor_response\": null,\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"pending\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T22:03:44.000Z\",\n      \"amount_settled\": null,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989217\",\n      \"tx_ref\": \"m0ckaham-1578002504686\",\n      \"flw_ref\": \"N/A\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 1000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 1000,\n      \"app_fee\": null,\n      \"merchant_fee\": 0,\n      \"processor_response\": null,\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"pending\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T22:01:57.000Z\",\n      \"amount_settled\": null,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989216\",\n      \"tx_ref\": \"m0ckaham-1578002147445\",\n      \"flw_ref\": \"N/A\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 1000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 1000,\n      \"app_fee\": null,\n      \"merchant_fee\": 0,\n      \"processor_response\": null,\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"pending\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T22:01:35.000Z\",\n      \"amount_settled\": null,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989214\",\n      \"tx_ref\": \"m0ckaham-1578002147445\",\n      \"flw_ref\": \"N/A\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 1000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 1000,\n      \"app_fee\": null,\n      \"merchant_fee\": 0,\n      \"processor_response\": null,\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"pending\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T21:55:56.000Z\",\n      \"amount_settled\": null,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989213\",\n      \"tx_ref\": \"m0ckaham-1578002107929\",\n      \"flw_ref\": \"N/A\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 100000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 100000,\n      \"app_fee\": null,\n      \"merchant_fee\": 0,\n      \"processor_response\": null,\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"pending\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T21:55:19.000Z\",\n      \"amount_settled\": null,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989208\",\n      \"tx_ref\": \"m0ckaham-1578001692462\",\n      \"flw_ref\": \"URF_1578001706192_7697035\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 100000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 100000,\n      \"app_fee\": 1400,\n      \"merchant_fee\": 0,\n      \"processor_response\": \"Approved Or Completed Successfully\",\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"successful\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T21:48:26.000Z\",\n      \"amount_settled\": 98550,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989207\",\n      \"tx_ref\": \"Flutterwave-Pages919998081709\",\n      \"flw_ref\": \"URF_1578001508809_392835\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 1000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 1000,\n      \"app_fee\": 14,\n      \"merchant_fee\": 0,\n      \"processor_response\": \"Approved Or Completed Successfully\",\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"successful\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T21:45:08.000Z\",\n      \"amount_settled\": 936,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    },\n    {\n      \"id\": \"989058\",\n      \"tx_ref\": \"m0ckaham-1577989302655\",\n      \"flw_ref\": \"URF_1577989314468_5262435\",\n      \"device_fingerprint\": \"e2b5cd3ec0fa99d45bf204a1401fb981\",\n      \"amount\": 50000,\n      \"currency\": \"NGN\",\n      \"charged_amount\": 50000,\n      \"app_fee\": 700,\n      \"merchant_fee\": 0,\n      \"processor_response\": \"Approved Or Completed Successfully\",\n      \"auth_model\": \"AUTH\",\n      \"ip\": \"197.211.58.137\",\n      \"narration\": \"Earth Gang\",\n      \"status\": \"successful\",\n      \"payment_type\": \"account\",\n      \"created_at\": \"2020-01-02T18:21:54.000Z\",\n      \"amount_settled\": 49300,\n      \"account\": {\n        \"nuban\": \"0690000031\",\n        \"bank\": \"ACCESS BANK NIGERIA\"\n      },\n      \"customer_name\": \"Yemi Desola\",\n      \"customer_email\": \"user@gmail.com\",\n      \"account_id\": \"73362\"\n    }\n  ]\n}"
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
                      "example": "Transactions fetched"
                    },
                    "meta": {
                      "type": "object",
                      "properties": {
                        "page_info": {
                          "type": "object",
                          "properties": {
                            "total": {
                              "type": "integer",
                              "example": 44,
                              "default": 0
                            },
                            "current_page": {
                              "type": "integer",
                              "example": 1,
                              "default": 0
                            },
                            "total_pages": {
                              "type": "integer",
                              "example": 5,
                              "default": 0
                            }
                          }
                        }
                      }
                    },
                    "data": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "example": "989226"
                          },
                          "tx_ref": {
                            "type": "string",
                            "example": "m0ckaham-1578002686748"
                          },
                          "flw_ref": {
                            "type": "string",
                            "example": "N/A"
                          },
                          "device_fingerprint": {
                            "type": "string",
                            "example": "e2b5cd3ec0fa99d45bf204a1401fb981"
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
                          "app_fee": {},
                          "merchant_fee": {
                            "type": "integer",
                            "example": 0,
                            "default": 0
                          },
                          "processor_response": {},
                          "auth_model": {
                            "type": "string",
                            "example": "AUTH"
                          },
                          "ip": {
                            "type": "string",
                            "example": "197.211.58.137"
                          },
                          "narration": {
                            "type": "string",
                            "example": "Earth Gang"
                          },
                          "status": {
                            "type": "string",
                            "example": "pending"
                          },
                          "payment_type": {
                            "type": "string",
                            "example": "account"
                          },
                          "created_at": {
                            "type": "string",
                            "example": "2020-01-02T22:06:45.000Z"
                          },
                          "amount_settled": {},
                          "account": {
                            "type": "object",
                            "properties": {
                              "nuban": {
                                "type": "string",
                                "example": "0690000031"
                              },
                              "bank": {
                                "type": "string",
                                "example": "ACCESS BANK NIGERIA"
                              }
                            }
                          },
                          "customer_name": {
                            "type": "string",
                            "example": "Yemi Desola"
                          },
                          "customer_email": {
                            "type": "string",
                            "example": "user@gmail.com"
                          },
                          "account_id": {
                            "type": "string",
                            "example": "73362"
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
  "_id": "5e36e596fe0cf5005142f849:5e37ff31745d100047be774d"
}
```