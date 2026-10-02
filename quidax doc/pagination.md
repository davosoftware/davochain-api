Fetch the complete documentation index at: https://docs.quidax.io/llms.txt. Use this file to discover all available pages before exploring further.

# Pagination

Quidax's API offers the ability to list through resources such as Withdraws, Instant Orders, and Orders, and more through its endpoints. For performance reasons, the API will return only a subset of the entire result set in each API call.

By default, all "List" endpoints return paginated results. You may use the query params `per_page` to control the number of results you see. For `per_page` the default will be 50 but can optionally be increased to a maximum of 100.

When reading paginated responses from the API, the following response headers will also be sent:

| Header        | Description                                                                                                                                |
| :------------ | :----------------------------------------------------------------------------------------------------------------------------------------- |
| x-next-page   | Indicates the cursor or page value required to fetch the next set of results. If this value is empty, there are no more results available. |
| x-total-pages | The total number of resources available for the requested endpoint.                                                                        |
| x-per-page    | Number of records returned per page                                                                                                        |
| x-page        | Current page number                                                                                                                        |
| x-next-page   | Next page number, if another page is available                                                                                             |