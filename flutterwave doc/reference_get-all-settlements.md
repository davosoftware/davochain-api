---
agentTools:
  projectIndex: https://developer.flutterwave.com/llms.txt
---

# Retrieve Settlements information

Query information for multiple settled transactions.

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
    "/settlements": {
      "get": {
        "summary": "Retrieve Settlements information",
        "description": "Query information for multiple settled transactions.",
        "operationId": "get-all-settlements",
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
            "name": "page",
            "in": "query",
            "description": "The page of the data to retrieve e.g. setting 1 retrieves the first page",
            "schema": {
              "type": "integer",
              "format": "int32",
              "default": 1
            }
          },
          {
            "name": "from",
            "in": "query",
            "description": "This is the specified date to start the data query from. It should take a YYYY-MM-DD format.",
            "schema": {
              "type": "string",
              "format": "date"
            }
          },
          {
            "name": "to",
            "in": "query",
            "description": "This is the specified end date for the data query. It should take a YYYY-MM-DD format.",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "subaccount_id",
            "in": "query",
            "description": "The subaccount ID to query settlement logs for. This is returned as subaccount_id when creating a subaccount.",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "disburse_ref",
            "in": "query",
            "description": "The disbursement reference ID to filter settlement logs by. This unique identifier is returned when a disbursement is initiated and can be used to track specific settlement transactions.",
            "schema": {
              "type": "string"
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
                    "value": "{\n   \"status\":\"success\",\n   \"message\":\"Settlements fetched\",\n   \"meta\":{\n      \"page_info\":{\n         \"total\":6,\n         \"current_page\":1,\n         \"total_pages\":1,\n         \"page_size\":6\n      }\n   },\n   \"data\":[\n      {\n         \"id\":5032128,\n         \"account_id\":35308,\n         \"merchant_name\":\"Flutterwave Developers\",\n         \"merchant_email\":\"cornelius@flutterwavego.com\",\n         \"settlement_account\":null,\n         \"bank_code\":null,\n         \"transaction_date\":\"2024-07-09T01:00:00.000Z\",\n         \"due_date\":\"2024-07-10T00:00:00.000Z\",\n         \"processed_date\":null,\n         \"status\":\"flagged\",\n         \"is_local\":true,\n         \"currency\":\"NGN\",\n         \"gross_amount\":202.8,\n         \"app_fee\":2.8,\n         \"merchant_fee\":0,\n         \"chargeback\":0,\n         \"refund\":0,\n         \"stampduty_charge\":0,\n         \"net_amount\":200,\n         \"transaction_count\":2,\n         \"processor_ref\":null,\n         \"disburse_ref\":null,\n         \"disburse_message\":null,\n         \"channel\":\"web\",\n         \"destination\":\"account\",\n         \"fx_data\":null,\n         \"flag_message\":\"No settlement account\",\n         \"source_bankcode\":null,\n         \"created_at\":\"2024-07-10T01:20:14.000Z\",\n         \"meta\":[],\n         \"refund_meta\":[],\n         \"chargeback_meta\":[]\n      },\n      {\n         \"id\":4976227,\n         \"account_id\":35308,\n         \"merchant_name\":\"Flutterwave Developers\",\n         \"merchant_email\":\"cornelius@flutterwavego.com\",\n         \"settlement_account\":null,\n         \"bank_code\":null,\n         \"transaction_date\":\"2024-06-24T01:00:00.000Z\",\n         \"due_date\":\"2024-06-25T00:00:00.000Z\",\n         \"processed_date\":null,\n         \"status\":\"flagged\",\n         \"is_local\":true,\n         \"currency\":\"NGN\",\n         \"gross_amount\":304.2,\n         \"app_fee\":4.2,\n         \"merchant_fee\":0,\n         \"chargeback\":0,\n         \"refund\":0,\n         \"stampduty_charge\":0,\n         \"net_amount\":300,\n         \"transaction_count\":2,\n         \"processor_ref\":null,\n         \"disburse_ref\":null,\n         \"disburse_message\":null,\n         \"channel\":\"web\",\n         \"destination\":\"account\",\n         \"fx_data\":null,\n         \"flag_message\":\"Settlement in Review\",\n         \"source_bankcode\":null,\n         \"created_at\":\"2024-06-25T01:09:28.000Z\",\n         \"meta\":[],\n         \"refund_meta\":[],\n         \"chargeback_meta\":[]\n      },\n      {\n         \"id\":4929297,\n         \"account_id\":35308,\n         \"merchant_name\":\"Flutterwave Developers\",\n         \"merchant_email\":\"cornelius@flutterwavego.com\",\n         \"settlement_account\":null,\n         \"bank_code\":null,\n         \"transaction_date\":\"2024-06-11T01:00:00.000Z\",\n         \"due_date\":\"2024-06-16T01:00:00.000Z\",\n         \"processed_date\":null,\n         \"status\":\"flagged\",\n         \"is_local\":false,\n         \"currency\":\"GBP\",\n         \"gross_amount\":1.04,\n         \"app_fee\":0.04,\n         \"merchant_fee\":0,\n         \"chargeback\":0,\n         \"refund\":0,\n         \"stampduty_charge\":0,\n         \"net_amount\":1,\n         \"transaction_count\":1,\n         \"processor_ref\":null,\n         \"disburse_ref\":null,\n         \"disburse_message\":null,\n         \"channel\":\"web\",\n         \"destination\":\"account\",\n         \"fx_data\":null,\n         \"flag_message\":\"No settlement account\",\n         \"source_bankcode\":null,\n         \"created_at\":\"2024-06-12T01:21:10.000Z\",\n         \"meta\":[],\n         \"refund_meta\":[],\n         \"chargeback_meta\":[]\n      },\n      {\n         \"id\":4929298,\n         \"account_id\":35308,\n         \"merchant_name\":\"Flutterwave Developers\",\n         \"merchant_email\":\"cornelius@flutterwavego.com\",\n         \"settlement_account\":null,\n         \"bank_code\":null,\n         \"transaction_date\":\"2024-06-11T01:00:00.000Z\",\n         \"due_date\":\"2024-06-12T00:00:00.000Z\",\n         \"processed_date\":null,\n         \"status\":\"flagged\",\n         \"is_local\":true,\n         \"currency\":\"NGN\",\n         \"gross_amount\":202.8,\n         \"app_fee\":2.8,\n         \"merchant_fee\":0,\n         \"chargeback\":0,\n         \"refund\":0,\n         \"stampduty_charge\":0,\n         \"net_amount\":200,\n         \"transaction_count\":2,\n         \"processor_ref\":null,\n         \"disburse_ref\":null,\n         \"disburse_message\":null,\n         \"channel\":\"web\",\n         \"destination\":\"account\",\n         \"fx_data\":null,\n         \"flag_message\":\"No settlement account\",\n         \"source_bankcode\":null,\n         \"created_at\":\"2024-06-12T01:21:10.000Z\",\n         \"meta\":[],\n         \"refund_meta\":[],\n         \"chargeback_meta\":[]\n      },\n      {\n         \"id\":4877552,\n         \"account_id\":35308,\n         \"merchant_name\":\"Flutterwave Developers\",\n         \"merchant_email\":\"cornelius@flutterwavego.com\",\n         \"settlement_account\":null,\n         \"bank_code\":null,\n         \"transaction_date\":\"2024-05-28T01:00:00.000Z\",\n         \"due_date\":\"2024-05-29T00:00:00.000Z\",\n         \"processed_date\":null,\n         \"status\":\"flagged\",\n         \"is_local\":true,\n         \"currency\":\"NGN\",\n         \"gross_amount\":405.6,\n         \"app_fee\":5.6,\n         \"merchant_fee\":0,\n         \"chargeback\":0,\n         \"refund\":0,\n         \"stampduty_charge\":0,\n         \"net_amount\":400,\n         \"transaction_count\":4,\n         \"processor_ref\":null,\n         \"disburse_ref\":null,\n         \"disburse_message\":null,\n         \"channel\":\"web\",\n         \"destination\":\"account\",\n         \"fx_data\":null,\n         \"flag_message\":\"Settlement in Review\",\n         \"source_bankcode\":null,\n         \"created_at\":\"2024-05-29T01:24:55.000Z\",\n         \"meta\":[],\n         \"refund_meta\":[],\n         \"chargeback_meta\":[]\n      },\n      {\n         \"id\":4863037,\n         \"account_id\":35308,\n         \"merchant_name\":\"Flutterwave Developers\",\n         \"merchant_email\":\"cornelius@flutterwavego.com\",\n         \"settlement_account\":null,\n         \"bank_code\":null,\n         \"transaction_date\":\"2024-05-24T01:00:00.000Z\",\n         \"due_date\":\"2024-05-25T00:00:00.000Z\",\n         \"processed_date\":null,\n         \"status\":\"flagged\",\n         \"is_local\":true,\n         \"currency\":\"NGN\",\n         \"gross_amount\":101.4,\n         \"app_fee\":1.4,\n         \"merchant_fee\":0,\n         \"chargeback\":0,\n         \"refund\":0,\n         \"stampduty_charge\":0,\n         \"net_amount\":100,\n         \"transaction_count\":1,\n         \"processor_ref\":null,\n         \"disburse_ref\":null,\n         \"disburse_message\":null,\n         \"channel\":\"web\",\n         \"destination\":\"account\",\n         \"fx_data\":null,\n         \"flag_message\":\"No settlement account\",\n         \"source_bankcode\":null,\n         \"created_at\":\"2024-05-25T01:29:26.000Z\",\n         \"meta\":[],\n         \"refund_meta\":[],\n         \"chargeback_meta\":[]\n      }\n   ]\n}\n"
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
                      "example": "Settlements fetched"
                    },
                    "meta": {
                      "type": "object",
                      "properties": {
                        "page_info": {
                          "type": "object",
                          "properties": {
                            "total": {
                              "type": "integer",
                              "example": 6,
                              "default": 0
                            },
                            "current_page": {
                              "type": "integer",
                              "example": 1,
                              "default": 0
                            },
                            "total_pages": {
                              "type": "integer",
                              "example": 1,
                              "default": 0
                            },
                            "page_size": {
                              "type": "integer",
                              "example": 6,
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
                            "type": "integer",
                            "example": 5032128,
                            "default": 0
                          },
                          "account_id": {
                            "type": "integer",
                            "example": 35308,
                            "default": 0
                          },
                          "merchant_name": {
                            "type": "string",
                            "example": "Flutterwave Developers"
                          },
                          "merchant_email": {
                            "type": "string",
                            "example": "cornelius@flutterwavego.com"
                          },
                          "settlement_account": {},
                          "bank_code": {},
                          "transaction_date": {
                            "type": "string",
                            "example": "2024-07-09T01:00:00.000Z"
                          },
                          "due_date": {
                            "type": "string",
                            "example": "2024-07-10T00:00:00.000Z"
                          },
                          "processed_date": {},
                          "status": {
                            "type": "string",
                            "example": "flagged"
                          },
                          "is_local": {
                            "type": "boolean",
                            "example": true,
                            "default": true
                          },
                          "currency": {
                            "type": "string",
                            "example": "NGN"
                          },
                          "gross_amount": {
                            "type": "number",
                            "example": 202.8,
                            "default": 0
                          },
                          "app_fee": {
                            "type": "number",
                            "example": 2.8,
                            "default": 0
                          },
                          "merchant_fee": {
                            "type": "integer",
                            "example": 0,
                            "default": 0
                          },
                          "chargeback": {
                            "type": "integer",
                            "example": 0,
                            "default": 0
                          },
                          "refund": {
                            "type": "integer",
                            "example": 0,
                            "default": 0
                          },
                          "stampduty_charge": {
                            "type": "integer",
                            "example": 0,
                            "default": 0
                          },
                          "net_amount": {
                            "type": "integer",
                            "example": 200,
                            "default": 0
                          },
                          "transaction_count": {
                            "type": "integer",
                            "example": 2,
                            "default": 0
                          },
                          "processor_ref": {},
                          "disburse_ref": {},
                          "disburse_message": {},
                          "channel": {
                            "type": "string",
                            "example": "web"
                          },
                          "destination": {
                            "type": "string",
                            "example": "account"
                          },
                          "fx_data": {},
                          "flag_message": {
                            "type": "string",
                            "example": "No settlement account"
                          },
                          "source_bankcode": {},
                          "created_at": {
                            "type": "string",
                            "example": "2024-07-10T01:20:14.000Z"
                          },
                          "meta": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {}
                            }
                          },
                          "refund_meta": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {}
                            }
                          },
                          "chargeback_meta": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {}
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
                    "value": "# 400 Bad Request - \n{\n    \"status\": \"error\",\n    \"message\": \"No settlement record found\",\n    \"data\": null\n}\n"
                  }
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
  "_id": "5e36e596fe0cf5005142f849:5e39aba91e3cb900121ab2ee"
}
```