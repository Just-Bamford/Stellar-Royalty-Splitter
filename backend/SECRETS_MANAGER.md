# Secrets Manager Integration

The Stellar Royalty Splitter backend supports loading signing keys from encrypted secrets stores to avoid storing plaintext secrets in environment variables or files.

## Supported Providers

1. **AWS Secrets Manager** - Enterprise-grade secrets management from AWS
2. **HashiCorp Vault** - Open-source secrets management platform
3. **File** - Plaintext file (for local development)
4. **Environment Variable** - Plaintext env var (for local development)

## Quick Start

### AWS Secrets Manager

1. **Create secret in AWS:**
```bash
aws secretsmanager create-secret \
  --name stellar-signing-key \
  --secret-string '{"signingKey":"SAAAA..."}'
```

2. **Configure backend:**
```bash
SECRETS_PROVIDER=aws
AWS_SECRET_NAME=stellar-signing-key
AWS_REGION=us-east-1
SECRETS_ENCRYPTION_KEY=your-32-character-encryption-key
```

3. **Install AWS SDK:**
```bash
npm install @aws-sdk/client-secrets-manager
```

### HashiCorp Vault

1. **Store secret in Vault:**
```bash
vault kv put secret/signing-key signingKey="SAAAA..."
```

2. **Configure backend:**
```bash
SECRETS_PROVIDER=vault
VAULT_ADDR=https://vault.example.com:8200
VAULT_TOKEN=hvs.your-token-here
VAULT_SECRET_PATH=secret/data/signing-key
SECRETS_ENCRYPTION_KEY=your-32-character-encryption-key
```

No additional dependencies required - uses Vault HTTP API.

### Local Development (Plaintext)

**Option 1: File**
```bash
echo "SAAAA..." > /path/to/key.txt
SIGNING_KEY_FILE=/path/to/key.txt
```

**Option 2: Environment Variable**
```bash
SERVER_SECRET_KEY=SAAAA...
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SECRETS_PROVIDER` | No | auto-detect | Provider: `aws`, `vault`, `file`, `env` |
| `AWS_SECRET_NAME` | AWS only | - | Name of secret in AWS Secrets Manager |
| `AWS_REGION` | No | `us-east-1` | AWS region |
| `VAULT_ADDR` | Vault only | - | Vault server URL |
| `VAULT_TOKEN` | Vault only | - | Vault authentication token |
| `VAULT_SECRET_PATH` | Vault only | - | Path to secret in Vault |
| `SIGNING_KEY_FILE` | File only | - | Path to plaintext key file |
| `SERVER_SECRET_KEY` | Env only | - | Plaintext signing key |
| `SECRETS_ENCRYPTION_KEY` | No | - | Key for at-rest encryption (32+ chars) |

### Auto-Detection

When `SECRETS_PROVIDER` is not set, the backend auto-detects the provider:

1. **AWS** - if `AWS_SECRET_NAME` is set
2. **Vault** - if `VAULT_ADDR` and `VAULT_TOKEN` are set
3. **File** - if `SIGNING_KEY_FILE` is set
4. **Env** - if `SERVER_SECRET_KEY` is set

## Secret Format

### AWS Secrets Manager

Store as JSON with one of these keys:
```json
{
  "signingKey": "SAAAA..."
}
```

Or:
```json
{
  "SECRET_KEY": "SAAAA..."
}
```

Or:
```json
{
  "key": "SAAAA..."
}
```

### HashiCorp Vault

Store with one of these keys:
```bash
vault kv put secret/signing-key signingKey="SAAAA..."
# or
vault kv put secret/signing-key SECRET_KEY="SAAAA..."
# or
vault kv put secret/signing-key key="SAAAA..."
```

Supports both KV v1 and v2 engines.

## Encryption at Rest

Configure `SECRETS_ENCRYPTION_KEY` to encrypt secrets in memory:

```bash
SECRETS_ENCRYPTION_KEY=your-32-character-encryption-key-here
```

**Best Practices:**
- Use a 32+ character random key
- Store the encryption key in a secure key management system
- Rotate the encryption key periodically
- Never commit the encryption key to version control

**Key Generation:**
```bash
# Generate a secure random key
openssl rand -base64 32
```

## Security Considerations

### Production

✅ **DO:**
- Use AWS Secrets Manager or HashiCorp Vault
- Configure `SECRETS_ENCRYPTION_KEY`
- Use IAM roles for AWS authentication (no hardcoded credentials)
- Use Vault AppRole or Kubernetes auth for Vault
- Rotate secrets regularly
- Monitor secret access logs

❌ **DON'T:**
- Use plaintext `SERVER_SECRET_KEY` in production
- Commit secrets to version control
- Share secrets via insecure channels
- Use the same secret across environments

### Local Development

✅ **DO:**
- Use `SIGNING_KEY_FILE` or `SERVER_SECRET_KEY`
- Keep local secrets in `.env` (gitignored)
- Use different keys for dev/staging/prod

❌ **DON'T:**
- Use production secrets locally
- Commit `.env` files

## Monitoring

Check secrets provider status:

```javascript
import { getSecretsProviderStatus } from './secrets-manager.js';

const status = getSecretsProviderStatus();
console.log(status);
// {
//   configured: true,
//   provider: 'aws',
//   explicit: true,
//   encryptionKeyConfigured: true,
//   availableProviders: {
//     aws: true,
//     vault: false,
//     file: false,
//     env: false
//   }
// }
```

## Troubleshooting

### AWS Secrets Manager

**Error: "AWS SDK not installed"**
```bash
npm install @aws-sdk/client-secrets-manager
```

**Error: "AccessDeniedException"**
- Verify IAM permissions include `secretsmanager:GetSecretValue`
- Check AWS credentials are configured (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)

**Error: "Secret key not found in response"**
- Verify secret JSON contains `signingKey`, `SECRET_KEY`, or `key` field

### HashiCorp Vault

**Error: "VAULT_ADDR is required"**
- Set `VAULT_ADDR` environment variable

**Error: "Vault API returned 403"**
- Verify `VAULT_TOKEN` is valid and not expired
- Check token has read permissions for the secret path

**Error: "Secret key not found in Vault response"**
- Verify secret contains `signingKey`, `SECRET_KEY`, or `key` field
- Check you're using the correct path (KV v2 uses `secret/data/...`)

### File Provider

**Error: "Signing key file not found"**
- Verify file path is correct
- Check file permissions are readable

### General

**Error: "Invalid Stellar signing secret key"**
- Verify secret starts with 'S'
- Check secret is a valid Stellar secret key (56 characters)

## Migration Guide

### From Plaintext to AWS Secrets Manager

1. **Create secret in AWS:**
```bash
aws secretsmanager create-secret \
  --name stellar-signing-key \
  --secret-string "{\"signingKey\":\"$SERVER_SECRET_KEY\"}"
```

2. **Update environment:**
```bash
# Remove
# SERVER_SECRET_KEY=SAAAA...

# Add
SECRETS_PROVIDER=aws
AWS_SECRET_NAME=stellar-signing-key
AWS_REGION=us-east-1
SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

3. **Install AWS SDK:**
```bash
npm install @aws-sdk/client-secrets-manager
```

4. **Restart backend:**
```bash
npm start
```

### From Plaintext to HashiCorp Vault

1. **Store secret in Vault:**
```bash
vault kv put secret/signing-key signingKey="$SERVER_SECRET_KEY"
```

2. **Update environment:**
```bash
# Remove
# SERVER_SECRET_KEY=SAAAA...

# Add
SECRETS_PROVIDER=vault
VAULT_ADDR=https://vault.example.com:8200
VAULT_TOKEN=hvs.your-token
VAULT_SECRET_PATH=secret/data/signing-key
SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

3. **Restart backend:**
```bash
npm start
```

## API Reference

### `loadSigningSecret()`

Load signing key from configured secrets provider.

**Returns:** `Promise<string>` - The signing key secret

**Throws:** Error if provider is misconfigured or secret cannot be loaded

### `encryptSecret(plaintext)`

Encrypt secret data at rest using AES-256-GCM.

**Parameters:**
- `plaintext` (string) - Secret to encrypt

**Returns:** Object with `encrypted`, `iv`, `authTag`, `algorithm`

### `decryptSecret(encryptedData)`

Decrypt secret data.

**Parameters:**
- `encryptedData` (object) - Encrypted data from `encryptSecret()`

**Returns:** `string` - Decrypted plaintext

### `getSecretsProviderStatus()`

Get secrets provider configuration status.

**Returns:** Object with provider info and availability

## Examples

### AWS with IAM Role (Recommended)

```javascript
// No AWS credentials in env - uses IAM role
process.env.SECRETS_PROVIDER = 'aws';
process.env.AWS_SECRET_NAME = 'stellar-signing-key';
process.env.AWS_REGION = 'us-east-1';
process.env.SECRETS_ENCRYPTION_KEY = 'your-key';

const secret = await loadSigningSecret();
```

### Vault with AppRole

```javascript
process.env.SECRETS_PROVIDER = 'vault';
process.env.VAULT_ADDR = 'https://vault.example.com:8200';
process.env.VAULT_TOKEN = 'hvs.token-from-approle';
process.env.VAULT_SECRET_PATH = 'secret/data/signing-key';
process.env.SECRETS_ENCRYPTION_KEY = 'your-key';

const secret = await loadSigningSecret();
```

### Local Development

```javascript
process.env.SERVER_SECRET_KEY = 'SAAAA...';

const secret = await loadSigningSecret();
```

## Support

For issues or questions:
- Open an issue on GitHub
- Check existing issues for similar problems
- Review logs for detailed error messages

