# Partner API Documentation

## Overview

The Stellar Royalty Splitter Partner API enables third-party NFT marketplaces to integrate royalty distribution and analytics services through a metered, rate-limited API.

## Authentication

All partner API endpoints require an API key sent in the `x-api-key` header:

```bash
curl -H "x-api-key: srs_live_..." https://api.example.com/api/v1/partner/me
```

Alternatively, you can use the `Authorization: Bearer` header:

```bash
curl -H "Authorization: Bearer srs_live_..." https://api.example.com/api/v1/partner/me
```

## Rate Limiting

The API enforces rate limits based on your subscription tier:

### Free Tier
- **Daily Limit**: 100 calls/day
- **Monthly Limit**: None
- **Price**: Free

### Pro Tier
- **Daily Limit**: None
- **Monthly Limit**: 10,000 calls/month
- **Price**: $50/month + $0.01 per additional call

### Enterprise Tier
- **Daily Limit**: Custom
- **Monthly Limit**: Custom
- **Price**: Negotiated

Rate limit headers are included in every response:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 85
X-RateLimit-Reset: 1635724800000
X-RateLimit-Tier: free
```

When your limit is exceeded, you'll receive a 429 status code with a `Retry-After` header.

## Endpoints

### Public Endpoints (No Key Required)

#### GET /api/v1/partner/pricing

Get the current pricing tier catalogue.

```bash
curl https://api.example.com/api/v1/partner/pricing
```

**Response:**
```json
{
  "success": true,
  "data": {
    "tiers": {
      "free": {
        "tier": "free",
        "label": "Free",
        "dailyLimit": 100,
        "monthlyLimit": null,
        "monthlyPriceCents": 0,
        "overageUnitPriceCents": null,
        "description": "100 calls/day, free forever. Rate limited when the daily quota is exhausted."
      },
      "pro": {
        "tier": "pro",
        "label": "Pro",
        "dailyLimit": null,
        "monthlyLimit": 10000,
        "monthlyPriceCents": 5000,
        "overageUnitPriceCents": 1,
        "description": "$50/month for 10,000 calls, then $0.01 per additional call."
      },
      "enterprise": {
        "tier": "enterprise",
        "label": "Enterprise",
        "dailyLimit": null,
        "monthlyLimit": null,
        "monthlyPriceCents": 0,
        "overageUnitPriceCents": null,
        "description": "Custom daily and monthly limits, negotiated pricing and SLA."
      }
    }
  }
}
```

### Partner Endpoints (API Key Required)

#### GET /api/v1/partner/me

Get your API key identity, tier, and live quota information.

```bash
curl -H "x-api-key: srs_live_..." https://api.example.com/api/v1/partner/me
```

**Response:**
```json
{
  "success": true,
  "data": {
    "keyId": "key_abc123...",
    "partnerId": "marketplace_xyz",
    "partnerName": "XYZ Marketplace",
    "tier": "pro",
    "createdAt": "2026-01-15T10:30:00.000Z",
    "expiresAt": null,
    "limits": {
      "dailyLimit": null,
      "monthlyLimit": 10000
    },
    "usage": {
      "dailyUsed": 45,
      "monthlyUsed": 2340,
      "window": "monthly",
      "limit": 10000,
      "remaining": 7660,
      "percentUsed": 23.4,
      "resetsAt": "2026-10-01T00:00:00.000Z"
    }
  }
}
```

#### GET /api/v1/partner/usage?days=30

Get your API call usage over time.

**Query Parameters:**
- `days` (optional): Number of days to include (1-365, default: 30)

```bash
curl -H "x-api-key: srs_live_..." "https://api.example.com/api/v1/partner/usage?days=30"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "usageOverTime": [
      {
        "day": "2026-09-01",
        "calls": 120,
        "rateLimited": 0,
        "errors": 5,
        "avgDurationMs": 245
      },
      {
        "day": "2026-09-02",
        "calls": 85,
        "rateLimited": 0,
        "errors": 2,
        "avgDurationMs": 198
      }
    ]
  }
}
```

#### GET /api/v1/partner/usage/endpoints?days=30&limit=10

Get your top API endpoints by call volume.

**Query Parameters:**
- `days` (optional): Number of days to include (1-365, default: 30)
- `limit` (optional): Number of endpoints to return (1-100, default: 10)

```bash
curl -H "x-api-key: srs_live_..." "https://api.example.com/api/v1/partner/usage/endpoints?days=30&limit=10"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "topEndpoints": [
      {
        "endpoint": "/api/v1/distribute",
        "method": "POST",
        "calls": 2340,
        "errors": 12,
        "avgDurationMs": 320
      },
      {
        "endpoint": "/api/v1/collaborators",
        "method": "GET",
        "calls": 1450,
        "errors": 3,
        "avgDurationMs": 150
      }
    ]
  }
}
```

#### GET /api/v1/partner/errors?days=30

Get your error rate breakdown.

**Query Parameters:**
- `days` (optional): Number of days to include (1-365, default: 30)

```bash
curl -H "x-api-key: srs_live_..." "https://api.example.com/api/v1/partner/errors?days=30"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "totals": {
      "totalCalls": 5000,
      "totalErrors": 25,
      "totalServerErrors": 5,
      "totalRateLimited": 0,
      "avgDurationMs": 220
    },
    "statusBreakdown": [
      {
        "statusCode": 200,
        "calls": 4975
      },
      {
        "statusCode": 400,
        "calls": 15
      },
      {
        "statusCode": 500,
        "calls": 5
      }
    ]
  }
}
```

## Error Responses

All errors follow a consistent format:

```json
{
  "success": false,
  "error": {
    "code": "api_key_required",
    "message": "An API key is required. Send it in the x-api-key header."
  }
}
```

### Common Error Codes

- `api_key_required`: No API key was provided
- `invalid_api_key`: The API key is invalid
- `api_key_revoked`: The API key has been revoked
- `api_key_expired`: The API key has expired
- `rate_limit_exceeded`: Rate limit has been exceeded

## Getting an API Key

To request an API key, contact the Stellar Royalty Splitter team with:

1. Your marketplace name
2. Your preferred tier (free, pro, or enterprise)
3. Expected monthly call volume
4. Technical contact information

## Best Practices

1. **Handle rate limits gracefully**: Check the `X-RateLimit-Remaining` header and implement backoff
2. **Cache responses**: Cache GET requests where appropriate to reduce call volume
3. **Monitor usage**: Use the `/partner/usage` endpoint to track your consumption
4. **Secure your keys**: Never commit API keys to version control or expose them client-side
5. **Use the correct headers**: Always include the `x-api-key` header in your requests

## Support

For API support, questions, or to request tier upgrades, contact:
- Email: api-support@stellar-royalty-splitter.com
- Documentation: https://docs.stellar-royalty-splitter.com
