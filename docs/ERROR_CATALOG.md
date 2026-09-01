# Error Code Catalog

This catalog documents all error codes returned by the Stellar Royalty Splitter API, including their HTTP status codes, retry-ability, recommended client actions, and example scenarios.

## Error Response Format

All error responses follow this structure:

```json
{
  "status": 400,
  "code": "validation_failed",
  "message": "Collaborators array must be non-empty",
  "error": "Collaborators array must be non-empty",
  "retryable": false,
  "retryAfter": null,
  "details": [{ "field": "collaborators", "message": "Collaborators array must be non-empty" }]
}
```

| Field | Description |
| ----- | ----------- |
| `status` | HTTP status code |
| `code` | Stable, machine-readable error code |
| `message` | Human-readable error message |
| `error` | Same as `message` (for backward compatibility) |
| `retryable` | Whether the request can be retried |
| `retryAfter` | Suggested retry delay in seconds (if retryable) |
| `details` | Additional error details (for validation errors) |

## Error Codes

### validation_failed
- **Status**: 400
- **Retryable**: No
- **Description**: Request body or query parameters failed schema validation
- **Client Action**: Fix the validation errors and retry
- **Example**: Missing required field, invalid data type

### bad_request
- **Status**: 400
- **Retryable**: No
- **Description**: Generic malformed request
- **Client Action**: Review request format and fix issues
- **Example**: Invalid JSON structure

### invalid_contract_id
- **Status**: 400
- **Retryable**: No
- **Description**: `contractId` is not a valid Soroban contract address
- **Client Action**: Provide a valid contract ID starting with `C...`
- **Example**: Using Stellar address instead of contract ID

### invalid_stellar_address
- **Status**: 400
- **Retryable**: No
- **Description**: Wallet address is not a valid Stellar address
- **Client Action**: Provide a valid Stellar address starting with `G...`
- **Example**: Using contract ID instead of wallet address

### invalid_query_parameter
- **Status**: 400
- **Retryable**: No
- **Description**: Query parameter failed validation
- **Client Action**: Fix the parameter value and retry
- **Example**: Invalid pagination offset or limit

### unauthorized
- **Status**: 401
- **Retryable**: No
- **Description**: Missing or invalid authentication
- **Client Action**: Provide valid authentication credentials
- **Example**: Missing API key or invalid signature

### forbidden
- **Status**: 403
- **Retryable**: No
- **Description**: Authenticated but not permitted (RBAC)
- **Client Action**: Check user permissions
- **Example**: User lacks required role

### not_found
- **Status**: 404
- **Retryable**: No
- **Description**: Resource does not exist
- **Client Action**: Verify resource exists or create it
- **Example**: Transaction ID not found

### already_initialized
- **Status**: 409
- **Retryable**: No
- **Description**: Contract already initialized
- **Client Action**: Skip initialization or use existing contract
- **Example**: Calling initialize on already-initialized contract

### conflict
- **Status**: 409
- **Retryable**: No
- **Description**: Generic conflict (resource state mismatch)
- **Client Action**: Resolve conflict and retry
- **Example**: Concurrent modification of same resource

### payload_too_large
- **Status**: 413
- **Retryable**: No
- **Description**: Request body exceeds size limit
- **Client Action**: Reduce payload size
- **Example**: Collaborators array too large

### unsupported_media_type
- **Status**: 415
- **Retryable**: No
- **Description**: POST without `Content-Type: application/json`
- **Client Action**: Set correct Content-Type header
- **Example**: Missing Content-Type header

### contract_simulation_failed
- **Status**: 400
- **Retryable**: No
- **Description**: Soroban simulation of contract call failed
- **Client Action**: Check contract state and parameters
- **Example**: Insufficient contract balance

### too_many_requests
- **Status**: 429
- **Retryable**: Yes
- **Retry After**: 60 seconds
- **Description**: Rate limit exceeded
- **Client Action**: Wait and retry after suggested delay
- **Example**: Exceeding API rate limits

### internal_server_error
- **Status**: 500
- **Retryable**: No
- **Description**: Unexpected server-side failure
- **Client Action**: Report issue to support
- **Example**: Unexpected server exception

### service_unavailable
- **Status**: 503
- **Retryable**: Yes
- **Retry After**: 5 seconds
- **Description**: Downstream service unavailable (RPC, Horizon)
- **Client Action**: Retry after suggested delay
- **Example**: Soroban RPC timeout

### request_timeout
- **Status**: 503
- **Retryable**: Yes
- **Retry After**: 5 seconds
- **Description**: Request exceeded timeout threshold
- **Client Action**: Retry with smaller payload or check service status
- **Example**: Slow RPC response

## Client Error Handling Decision Tree

```
Error Response
├── Is retryable?
│   ├── Yes → Wait retryAfter seconds → Retry request
│   └── No → Check error code
│       ├── validation_failed → Fix validation errors
│       ├── invalid_* → Fix parameter values
│       ├── unauthorized → Provide auth
│       ├── forbidden → Check permissions
│       ├── not_found → Verify resource exists
│       ├── contract_simulation_failed → Check contract state
│       └── internal_server_error → Report to support
```

## Auto-Retry Logic Example

```javascript
async function makeRequest(url, options, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    const response = await fetch(url, options);
    if (response.ok) return response.json();
    
    const error = await response.json();
    if (error.retryable && error.retryAfter) {
      await new Promise(resolve => setTimeout(resolve, error.retryAfter * 1000));
      retries++;
      continue;
    }
    
    throw new Error(error.message);
  }
  throw new Error('Max retries exceeded');
}
```

## Additional Resources

- [API Documentation](../backend/API.md)
- [Contribution Guidelines](../CONTRIBUTING.md)
