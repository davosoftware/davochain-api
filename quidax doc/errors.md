Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Errors

| Error Code | Status            | Meaning                                                                                                          |
| :--------- | :---------------- | :--------------------------------------------------------------------------------------------------------------- |
| 400        | Bad request       | Bad request. Review the data sent in the request. Usually, this means a required piece of information is missing |
| 401        | Unauthorized      | Unauthorized. This happens when you provide an invalid or non-existent secret API key                            |
| 404        | Not Found         | Resource not found. The data requested does not exist.                                                           |
| 403        | Forbidden         | Not enough permission to perform this operation                                                                  |
| 429        | Too Many Requests | You're making too many requests!                                                                                 |
| 5XX        | Server Error      | Something went wrong.                                                                                            |