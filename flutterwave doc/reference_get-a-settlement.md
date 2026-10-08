# reference_get-a-settlement

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
    "/settlements/{id}": {
      "get": {
        "summary": "Retrieve a single Settlement log",
        "description": "Query and retrieve information for a single settlement.",
        "operationId": "get-a-settlement",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "description": "This is a unique identifier for the particular settlement you want to fetch. It is returned in the call to list all settlements as data.id.",
            "schema": {
              "type": "integer",
              "format": "int32",
              "default": 41497
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
          },
          {
            "name": "page",
            "in": "query",
            "description": "This is the page number to retrieve e.g. setting 1 retrieves the first page.",
            "schema": {
              "type": "string",
              "default": "1"
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
                    "value": "{\n  \"status\": \"success\",\n  \"message\": \"Settlement fetched\",\n  \"data\": {\n    \"id\": 41497,\n    \"account_id\": 73362,\n    \"merchant_name\": \"Earth Gang\",\n    \"merchant_email\": \"selma.m0ckaham@flutterwavego.com\",\n    \"settlement_account\": \"0031318432\",\n    \"bank_code\": \"063\",\n    \"transaction_date\": \"2019-12-30T04:00:00.000Z\",\n    \"due_date\": \"2019-12-30T04:00:00.000Z\",\n    \"processed_date\": null,\n    \"status\": \"completed\",\n    \"is_local\": 1,\n    \"currency\": \"NGN\",\n    \"gross_amount\": 50800,\n    \"app_fee\": 950,\n    \"merchant_fee\": 0,\n    \"chargeback\": 0,\n    \"refund\": 0,\n    \"stampduty_charge\": 0,\n    \"net_amount\": 49850,\n    \"transaction_count\": 5,\n    \"processor_ref\": null,\n    \"disburse_ref\": \"RV3E18675549F6A0\",\n    \"disburse_message\": null,\n    \"channel\": \"web\",\n    \"destination\": \"autowallet\",\n    \"fx_data\": null,\n    \"flag_message\": null,\n    \"meta\": \"[906256,906358,906301,906362,906319]\",\n    \"refund_meta\": null,\n    \"chargeback_meta\": null,\n    \"source_bankcode\": null,\n    \"created_at\": \"2019-12-31T01:30:00.000Z\",\n    \"transactions\": [\n      {\n        \"customer_email\": \"h0vkard@flw.ext\",\n        \"flw_ref\": \"FLW-MOCK-RECURR-42b3daee9f470127dacd19560533f3a6\",\n        \"tx_ref\": \"Rave-Pages017117571060\",\n        \"id\": 984411,\n        \"charged_amount\": 10140,\n        \"app_fee\": 190,\n        \"merchant_fee\": 0,\n        \"stampduty_charge\": 0,\n        \"settlement_amount\": 9950,\n        \"status\": \"successful\",\n        \"payment_entity\": \"card\",\n        \"transaction_date\": \"2019-12-30\",\n        \"currency\": \"NGN\",\n        \"card_locale\": \"LOCAL\",\n        \"rrn\": \"N/A\",\n        \"subaccount_settlement\": 0\n      },\n      {\n        \"customer_email\": \"h0vkard@flw.ext\",\n        \"flw_ref\": \"FLW-MOCK-RECURR-c536481525f02f76409892f517a16300\",\n        \"tx_ref\": \"Rave-Pages017117571060\",\n        \"id\": 984456,\n        \"charged_amount\": 10140,\n        \"app_fee\": 190,\n        \"merchant_fee\": 0,\n        \"stampduty_charge\": 0,\n        \"settlement_amount\": 9950,\n        \"status\": \"successful\",\n        \"payment_entity\": \"card\",\n        \"transaction_date\": \"2019-12-30\",\n        \"currency\": \"NGN\",\n        \"card_locale\": \"LOCAL\",\n        \"rrn\": \"N/A\",\n        \"subaccount_settlement\": 0\n      },\n      {\n        \"customer_email\": \"h0vkard@flw.ext\",\n        \"flw_ref\": \"FLW-MOCK-RECURR-d22d0ec0955047e9648bec46da40c987\",\n        \"tx_ref\": \"Rave-Pages017117571060\",\n        \"id\": 984474,\n        \"charged_amount\": 10190,\n        \"app_fee\": 190,\n        \"merchant_fee\": 0,\n        \"stampduty_charge\": 0,\n        \"settlement_amount\": 10000,\n        \"status\": \"successful\",\n        \"payment_entity\": \"card\",\n        \"transaction_date\": \"2019-12-30\",\n        \"currency\": \"NGN\",\n        \"card_locale\": \"LOCAL\",\n        \"rrn\": \"N/A\",\n        \"subaccount_settlement\": 0\n      },\n      {\n        \"customer_email\": \"h0vkard@flw.ext\",\n        \"flw_ref\": \"FLW-MOCK-RECURR-e55f863f14a95816e0939e7c4625ee43\",\n        \"tx_ref\": \"Rave-Pages017117571060\",\n        \"id\": 984513,\n        \"charged_amount\": 10190,\n        \"app_fee\": 190,\n        \"merchant_fee\": 0,\n        \"stampduty_charge\": 0,\n        \"settlement_amount\": 10000,\n        \"status\": \"successful\",\n        \"payment_entity\": \"card\",\n        \"transaction_date\": \"2019-12-30\",\n        \"currency\": \"NGN\",\n        \"card_locale\": \"LOCAL\",\n        \"rrn\": \"N/A\",\n        \"subaccount_settlement\": 0\n      },\n      {\n        \"customer_email\": \"h0vkard@flw.ext\",\n        \"flw_ref\": \"FLW-MOCK-RECURR-6100e5300876cef2270b2e31bc9cc16e\",\n        \"tx_ref\": \"Rave-Pages017117571060\",\n        \"id\": 984517,\n        \"charged_amount\": 10140,\n        \"app_fee\": 190,\n        \"merchant_fee\": 0,\n        \"stampduty_charge\": 0,\n        \"settlement_amount\": 9950,\n        \"status\": \"successful\",\n        \"payment_entity\": \"card\",\n        \"transaction_date\": \"2019-12-30\",\n        \"currency\": \"NGN\",\n        \"card_locale\": \"LOCAL\",\n        \"rrn\": \"N/A\",\n        \"subaccount_settlement\": 0\n      }\n    ]\n  }\n}"
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
                      "example": "Settlement fetched"
                    },
                    "data": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "example": 41497,
                          "default": 0
                        },
                        "account_id": {
                          "type": "integer",
                          "example": 73362,
                          "default": 0
                        },
                        "merchant_name": {
                          "type": "string",
                          "example": "Earth Gang"
                        },
                        "merchant_email": {
                          "type": "string",
                          "example": "selma.m0ckaham@flutterwavego.com"
                        },
                        "settlement_account": {
                          "type": "string",
                          "example": "0031318432"
                        },
                        "bank_code": {
                          "type": "string",
                          "example": "063"
                        },
                        "transaction_date": {
                          "type": "string",
                          "example": "2019-12-30T04:00:00.000Z"
                        },
                        "due_date": {
                          "type": "string",
                          "example": "2019-12-30T04:00:00.000Z"
                        },
                        "processed_date": {},
                        "status": {
                          "type": "string",
                          "example": "completed"
                        },
                        "is_local": {
                          "type": "integer",
                          "example": 1,
                          "default": 0
                        },
                        "currency": {
                          "type": "string",
                          "example": "NGN"
                        },
                        "gross_amount": {
                          "type": "integer",
                          "example": 50800,
                          "default": 0
                        },
                        "app_fee": {
                          "type": "integer",
                          "example": 950,
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
                          "example": 49850,
                          "default": 0
                        },
                        "transaction_count": {
                          "type": "integer",
                          "example": 5,
                          "default": 0
                        },
                        "processor_ref": {},
                        "disburse_ref": {
                          "type": "string",
                          "example": "RV3E18675549F6A0"
                        },
                        "disburse_message": {},
                        "channel": {
                          "type": "string",
                          "example": "web"
                        },
                        "destination": {
                          "type": "string",
                          "example": "autowallet"
                        },
                        "fx_data": {},
                        "flag_message": {},
                        "meta": {
                          "type": "string",
                          "example": "[906256,906358,906301,906362,906319]"
                        },
                        "refund_meta": {},
                        "chargeback_meta": {},
                        "source_bankcode": {},
                        "created_at": {
                          "type": "string",
                          "example": "2019-12-31T01:30:00.000Z"
                        },
                        "transactions": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "customer_email": {
                                "type": "string",
                                "example": "h0vkard@flw.ext"
                              },
                              "flw_ref": {
                                "type": "string",
                                "example": "FLW-MOCK-RECURR-42b3daee9f470127dacd19560533f3a6"
                              },
                              "tx_ref": {
                                "type": "string",
                                "example": "Rave-Pages017117571060"
                              },
                              "id": {
                                "type": "integer",
                                "example": 984411,
                                "default": 0
                              },
                              "charged_amount": {
                                "type": "integer",
                                "example": 10140,
                                "default": 0
                              },
                              "app_fee": {
                                "type": "integer",
                                "example": 190,
                                "default": 0
                              },
                              "merchant_fee": {
                                "type": "integer",
                                "example": 0,
                                "default": 0
                              },
                              "stampduty_charge": {
                                "type": "integer",
                                "example": 0,
                                "default": 0
                              },
                              "settlement_amount": {
                                "type": "integer",
                                "example": 9950,
                                "default": 0
                              },
                              "status": {
                                "type": "string",
                                "example": "successful"
                              },
                              "payment_entity": {
                                "type": "string",
                                "example": "card"
                              },
                              "transaction_date": {
                                "type": "string",
                                "example": "2019-12-30"
                              },
                              "currency": {
                                "type": "string",
                                "example": "NGN"
                              },
                              "card_locale": {
                                "type": "string",
                                "example": "LOCAL"
                              },
                              "rrn": {
                                "type": "string",
                                "example": "N/A"
                              },
                              "subaccount_settlement": {
                                "type": "integer",
                                "example": 0,
                                "default": 0
                              }
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
        "deprecated": false,
        "x-readme": {
          "code-samples": [
            {
              "language": "curl",
              "code": "curl --location --request GET '{{BASE_API_URL}}/settlements/41497' \\\n--header 'Authorization: Bearer {SEC_KEY}'"
            },
            {
              "language": "javascript",
              "code": "var request = require('request');\nvar options = {\n  'method': 'GET',\n  'url': '{{BASE_API_URL}}/settlements/41497',\n  'headers': {\n    'Authorization': 'Bearer {SEC_KEY}'\n  }\n};\nrequest(options, function (error, response) { \n  if (error) throw new Error(error);\n  console.log(response.body);\n});",
              "name": "Node"
            },
            {
              "language": "php",
              "code": "<?php\n\n$curl = curl_init();\n\ncurl_setopt_array($curl, array(\n  CURLOPT_URL => \"{{BASE_API_URL}}/settlements/41497\",\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_ENCODING => \"\",\n  CURLOPT_MAXREDIRS => 10,\n  CURLOPT_TIMEOUT => 0,\n  CURLOPT_FOLLOWLOCATION => true,\n  CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,\n  CURLOPT_CUSTOMREQUEST => \"GET\",\n  CURLOPT_HTTPHEADER => array(\n    \"Authorization: Bearer {SEC_KEY}\"\n  ),\n));\n\n$response = curl_exec($curl);\n\ncurl_close($curl);\necho $response;"
            },
            {
              "language": "ruby",
              "code": "require \"uri\"\nrequire \"net/http\"\n\nurl = URI(\"{{BASE_API_URL}}/settlements/41497\")\n\nhttp = Net::HTTP.new(url.host, url.port);\nrequest = Net::HTTP::Get.new(url)\nrequest[\"Authorization\"] = \"Bearer {SEC_KEY}\"\n\nresponse = http.request(request)\nputs response.read_body"
            }
          ],
          "samples-languages": [
            "curl",
            "javascript",
            "php",
            "ruby"
          ]
        }
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
  "_id": "5e36e596fe0cf5005142f849:5e39acedab57380045e41643"
}
```
