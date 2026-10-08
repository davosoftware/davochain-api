# reference_get-a-virtual-account-detail

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
    "/virtual-account-numbers/{order_ref}": {
      "get": {
        "summary": "Get a virtual account number",
        "description": "Retrieve virtual account information using its order reference.",
        "operationId": "get-a-virtual-account-detail",
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
            "name": "order_ref",
            "in": "path",
            "description": "The order reference generated for the virtual account.",
            "schema": {
              "type": "string",
              "default": "URF_1579513580629_5981535"
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
                    "value": "{\n    \"status\": \"success\",\n    \"message\": \"Virtual nuban fetched\",\n    \"data\": {\n        \"response_code\": \"02\",\n        \"response_message\": \"Transaction in progress\",\n        \"flw_ref\": \"JYEF3181178471763041012888\",\n        \"order_ref\": \"URF_1784717629447_5331035\",\n        \"account_number\": \"9135488646\",\n        \"frequency\": \"N/A\",\n        \"bank_name\": \"Flutterwave MFB (Formerly OK MFB)\",\n        \"created_at\": \"2026-07-22 11:53:50\",\n        \"expiry_date\": \"2026-07-22 12:53:50\",\n        \"note\": \"Please make a bank transfer to Kids Foundation\",\n        \"amount\": \"102.00\"\n    }\n}"
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
                      "example": "Virtual nuban fetched"
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
                          "example": "JYEF3181178471763041012888"
                        },
                        "order_ref": {
                          "type": "string",
                          "example": "URF_1784717629447_5331035"
                        },
                        "account_number": {
                          "type": "string",
                          "example": "9135488646"
                        },
                        "frequency": {
                          "type": "string",
                          "example": "N/A"
                        },
                        "bank_name": {
                          "type": "string",
                          "example": "Flutterwave MFB (Formerly OK MFB)"
                        },
                        "created_at": {
                          "type": "string",
                          "example": "2026-07-22 11:53:50"
                        },
                        "expiry_date": {
                          "type": "string",
                          "example": "2026-07-22 12:53:50"
                        },
                        "note": {
                          "type": "string",
                          "example": "Please make a bank transfer to Kids Foundation"
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
  "_id": "5e36e596fe0cf5005142f849:5e3aba4f8830c200657819d7"
}
```
