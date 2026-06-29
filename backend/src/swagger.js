import swaggerJsdoc from 'swagger-jsdoc';

const components = {
  schemas: {
    ContractId: {
      type: 'string',
      pattern: '^C[A-Z2-7]{55}$',
      example: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      description: 'Stellar contract address (56-char C-prefixed)',
    },
    TransactionResponse: {
      type: 'object',
      properties: {
        xdr: { type: 'string', description: 'Base64-encoded unsigned transaction XDR' },
        transactionId: { type: 'integer', description: 'Internal transaction record ID' },
      },
      required: ['xdr', 'transactionId'],
    },
    ErrorResponse: {
      type: 'object',
      properties: { error: { type: 'string' } },
      required: ['error'],
    },
  },
  parameters: {
    ContractIdPath: {
      name: 'contractId',
      in: 'path',
      required: true,
      schema: { $ref: '#/components/schemas/ContractId' },
    },
    LimitQuery: {
      name: 'limit',
      in: 'query',
      schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
    },
    OffsetQuery: {
      name: 'offset',
      in: 'query',
      schema: { type: 'integer', default: 0, minimum: 0 },
    },
  },
};

const paths1 = {
  '/api/v1/initialize': {
    post: {
      tags: ['Contract'],
      summary: 'Initialize collaborator split for a contract',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['contractId', 'walletAddress', 'collaborators', 'shares'],
              properties: {
                contractId: { $ref: '#/components/schemas/ContractId' },
                walletAddress: { type: 'string', example: 'GARTIST...' },
                collaborators: { type: 'array', items: { type: 'string' }, example: ['GARTIST...', 'GMUSICIAN...'] },
                shares: { type: 'array', items: { type: 'integer' }, example: [5000, 5000], description: 'Basis points, must sum to 10000' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Unsigned XDR returned', content: { 'application/json': { schema: { $ref: '#/components/schemas/TransactionResponse' } } } },
        400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/distribute': {
    post: {
      tags: ['Distribution'],
      summary: 'Distribute primary sale proceeds to collaborators',
      parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Optional idempotency key' }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['contractId', 'walletAddress', 'tokenId'],
              properties: {
                contractId: { $ref: '#/components/schemas/ContractId' },
                walletAddress: { type: 'string' },
                tokenId: { type: 'string', example: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Unsigned XDR returned', content: { 'application/json': { schema: { $ref: '#/components/schemas/TransactionResponse' } } } },
        409: { description: 'Duplicate idempotency key', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/collaborators/{contractId}': {
    get: {
      tags: ['Collaborators'],
      summary: 'List collaborators and their basis-point shares',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: {
          description: 'Collaborator list',
          content: {
            'application/json': {
              schema: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, basisPoints: { type: 'integer' } } } },
              example: [{ address: 'GARTIST...', basisPoints: 5000 }],
            },
          },
        },
        404: { description: 'Contract not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/health': {
    get: {
      tags: ['System'],
      summary: 'Health check',
      responses: {
        200: {
          description: 'Service health',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { ok: { type: 'boolean' }, dbVersion: { type: 'string' }, network: { type: 'string' }, horizon: { type: 'string' }, contract: { type: 'string' } } },
              example: { ok: true, dbVersion: '1', network: 'testnet', horizon: 'ok', contract: 'ok' },
            },
          },
        },
      },
    },
  },
  '/api/v1/simulate': {
    post: {
      tags: ['Distribution'],
      summary: 'Simulate a distribution to preview fees and recipient amounts',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['contractId', 'walletAddress', 'tokenId'],
              properties: {
                contractId: { $ref: '#/components/schemas/ContractId' },
                walletAddress: { type: 'string' },
                tokenId: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Simulation result',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { fee: { type: 'string' }, recipientAmounts: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, amount: { type: 'string' } } } }, contractError: { type: 'string', nullable: true } } },
              example: { fee: '100', recipientAmounts: [{ address: 'GARTIST...', amount: '500000000' }], contractError: null },
            },
          },
        },
        400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/history/{contractId}': {
    get: {
      tags: ['History'],
      summary: 'Get distribution history for a contract',
      parameters: [
        { $ref: '#/components/parameters/ContractIdPath' },
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
      ],
      responses: {
        200: {
          description: 'Paginated history',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { type: 'object' } }, pagination: { type: 'object', properties: { total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' } } } } },
            },
          },
        },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/transaction/{txHash}': {
    get: {
      tags: ['Transactions'],
      summary: 'Look up a transaction by hash',
      parameters: [{ name: 'txHash', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Transaction detail', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object' } } } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/transaction/confirm/{txHash}': {
    post: {
      tags: ['Transactions'],
      summary: 'Confirm a submitted transaction',
      parameters: [{ name: 'txHash', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                blockTime: { type: 'integer', nullable: true },
                errorMessage: { type: 'string', nullable: true },
                transactionId: { type: 'integer', nullable: true },
              },
            },
            example: { blockTime: 1700000000, errorMessage: null, transactionId: 42 },
          },
        },
      },
      responses: {
        200: { description: 'Confirmation result', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, status: { type: 'string' }, ledger: { type: 'integer' }, message: { type: 'string' } } } } } },
        404: { description: 'Transaction not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/audit/{contractId}': {
    get: {
      tags: ['Audit'],
      summary: 'Get audit log for a contract',
      parameters: [
        { $ref: '#/components/parameters/ContractIdPath' },
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
      ],
      responses: {
        200: { description: 'Audit log', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { type: 'object' } }, pagination: { type: 'object' } } } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    post: {
      tags: ['Audit'],
      summary: 'Append an audit log entry',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['action'],
              properties: {
                action: { type: 'string', example: 'DISTRIBUTE' },
                user: { type: 'string', nullable: true },
                details: { type: 'object', nullable: true },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Entry created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
        400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};

const paths2 = {
  '/api/v1/webhooks/{contractId}': {
    post: {
      tags: ['Webhooks'],
      summary: 'Register a webhook for a contract',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri', example: 'https://example.com/hook' } } } } },
      },
      responses: {
        200: { description: 'Webhook registered', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, webhookId: { type: 'string' }, url: { type: 'string' }, message: { type: 'string' } } } } } },
        400: { description: 'Invalid URL', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['Webhooks'],
      summary: 'List webhooks for a contract',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: { description: 'Webhook list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { type: 'object', properties: { webhookId: { type: 'string' }, url: { type: 'string' } } } } } } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/webhooks/{contractId}/{webhookId}': {
    delete: {
      tags: ['Webhooks'],
      summary: 'Delete a webhook',
      parameters: [
        { $ref: '#/components/parameters/ContractIdPath' },
        { name: 'webhookId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/analytics/{contractId}': {
    get: {
      tags: ['Analytics'],
      summary: 'Get analytics for a contract',
      parameters: [
        { $ref: '#/components/parameters/ContractIdPath' },
        { name: 'start', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'end', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        200: {
          description: 'Analytics data',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  data: {
                    type: 'object',
                    properties: {
                      totalDistributed: { type: 'string' },
                      totalTransactions: { type: 'integer' },
                      averagePayout: { type: 'string' },
                      topEarners: { type: 'array', items: { type: 'object' } },
                      distributionTrends: { type: 'array', items: { type: 'object' } },
                      collaboratorStats: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
          },
        },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/secondary-royalty': {
    post: {
      tags: ['Secondary Royalty'],
      summary: 'Record a secondary sale and compute royalty XDR',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['contractId', 'walletAddress', 'nftId', 'previousOwner', 'newOwner', 'salePrice', 'saleToken'],
              properties: {
                contractId: { $ref: '#/components/schemas/ContractId' },
                walletAddress: { type: 'string' },
                nftId: { type: 'string', example: 'NFT_001' },
                previousOwner: { type: 'string' },
                newOwner: { type: 'string' },
                salePrice: { type: 'string', example: '5000000000' },
                saleToken: { type: 'string' },
                royaltyRate: { type: 'number', example: 500, description: 'Basis points (optional, uses on-chain rate if omitted)' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Royalty XDR', content: { 'application/json': { schema: { type: 'object', properties: { xdr: { type: 'string' }, transactionId: { type: 'integer' }, royaltyAmount: { type: 'string' }, royaltyRateUsed: { type: 'number' } } } } } },
        400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/secondary-royalty/set-rate': {
    post: {
      tags: ['Secondary Royalty'],
      summary: 'Set the royalty rate for a contract (admin)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['contractId', 'walletAddress', 'royaltyRate'],
              properties: {
                contractId: { $ref: '#/components/schemas/ContractId' },
                walletAddress: { type: 'string' },
                royaltyRate: { type: 'integer', example: 500, description: 'Basis points' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Rate set XDR', content: { 'application/json': { schema: { $ref: '#/components/schemas/TransactionResponse' } } } },
        400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/secondary-royalty/rate/{contractId}': {
    get: {
      tags: ['Secondary Royalty'],
      summary: 'Get the current royalty rate',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: { description: 'Royalty rate', content: { 'application/json': { schema: { type: 'object', properties: { contractId: { type: 'string' }, royaltyRate: { type: 'integer' } } }, example: { contractId: 'CDLZFC3...', royaltyRate: 500 } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/secondary-royalty/distribute': {
    post: {
      tags: ['Secondary Royalty'],
      summary: 'Distribute accumulated secondary royalties',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['contractId', 'walletAddress', 'tokenId'],
              properties: {
                contractId: { $ref: '#/components/schemas/ContractId' },
                walletAddress: { type: 'string' },
                tokenId: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Distribution XDR', content: { 'application/json': { schema: { type: 'object', properties: { xdr: { type: 'string' }, transactionId: { type: 'integer' }, numberOfSales: { type: 'integer' }, totalRoyalties: { type: 'string' } } } } } },
        400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/secondary-royalty/stats/{contractId}': {
    get: {
      tags: ['Secondary Royalty'],
      summary: 'Get secondary royalty statistics',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: { description: 'Stats object', content: { 'application/json': { schema: { type: 'object' } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/secondary-royalty/sales/{contractId}': {
    get: {
      tags: ['Secondary Royalty'],
      summary: 'List secondary sales for a contract',
      parameters: [
        { $ref: '#/components/parameters/ContractIdPath' },
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        { name: 'nftId', in: 'query', schema: { type: 'string' } },
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        200: { description: 'Sales list', content: { 'application/json': { schema: { type: 'object', properties: { sales: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } } } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/secondary-royalty/distributions/{contractId}': {
    get: {
      tags: ['Secondary Royalty'],
      summary: 'List secondary royalty distributions',
      parameters: [
        { $ref: '#/components/parameters/ContractIdPath' },
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
      ],
      responses: {
        200: { description: 'Distributions list', content: { 'application/json': { schema: { type: 'object', properties: { distributions: { type: 'array', items: { type: 'object' } } } } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/secondary-royalty/pool/{contractId}': {
    get: {
      tags: ['Secondary Royalty'],
      summary: 'Get the pending royalty pool balance',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: { description: 'Pool balance', content: { 'application/json': { schema: { type: 'object', properties: { poolBalance: { type: 'string' } } }, example: { poolBalance: '250000000' } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};

const paths3 = {
  '/api/v1/contract/state': {
    get: {
      tags: ['Contract'],
      summary: 'Get full contract state',
      parameters: [
        { name: 'contractId', in: 'query', required: true, schema: { $ref: '#/components/schemas/ContractId' } },
        { name: 'tokenId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Full state', content: { 'application/json': { schema: { type: 'object' } } } },
        400: { description: 'Missing params', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/contract/info': {
    get: {
      tags: ['Contract'],
      summary: 'Get contract info',
      parameters: [
        { name: 'contractId', in: 'query', required: true, schema: { $ref: '#/components/schemas/ContractId' } },
        { name: 'tokenId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Contract info', content: { 'application/json': { schema: { type: 'object' } } } },
        400: { description: 'Missing params', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/contract/status/{contractId}': {
    get: {
      tags: ['Contract'],
      summary: 'Check whether a contract is initialized',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: { description: 'Initialization status', content: { 'application/json': { schema: { type: 'object', properties: { initialized: { type: 'boolean' } } }, example: { initialized: true } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/contract/balance/{contractId}': {
    get: {
      tags: ['Contract'],
      summary: 'Get contract token balance',
      parameters: [
        { $ref: '#/components/parameters/ContractIdPath' },
        { name: 'tokenId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Balance', content: { 'application/json': { schema: { type: 'object', properties: { balance: { type: 'string' } } }, example: { balance: '1000000000' } } } },
        400: { description: 'Missing tokenId', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/contract/collaborator-count/{contractId}': {
    get: {
      tags: ['Contract'],
      summary: 'Get number of collaborators',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: { description: 'Count', content: { 'application/json': { schema: { type: 'object', properties: { contractId: { type: 'string' }, count: { type: 'integer' } } }, example: { contractId: 'CDLZFC3...', count: 3 } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/contract/shares-total/{contractId}': {
    get: {
      tags: ['Contract'],
      summary: 'Get sum of all collaborator shares',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: { description: 'Total shares', content: { 'application/json': { schema: { type: 'object', properties: { contractId: { type: 'string' }, totalShares: { type: 'integer' } } }, example: { contractId: 'CDLZFC3...', totalShares: 10000 } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/v1/contract/version/{contractId}': {
    get: {
      tags: ['Contract'],
      summary: 'Get contract WASM version',
      parameters: [{ $ref: '#/components/parameters/ContractIdPath' }],
      responses: {
        200: { description: 'Version', content: { 'application/json': { schema: { type: 'object', properties: { contractId: { type: 'string' }, version: { type: 'string' } } }, example: { contractId: 'CDLZFC3...', version: '1.0.0' } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/admin/rotate-key': {
    post: {
      tags: ['Admin'],
      summary: 'Hot-reload the server signing key without redeploy',
      security: [{ bearerAuth: [] }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                secretKey: { type: 'string', description: 'New Stellar secret key (S...)' },
                reloadFromFile: { type: 'boolean', description: 'Reload from SIGNING_KEY_FILE instead' },
              },
            },
            example: { reloadFromFile: true },
          },
        },
      },
      responses: {
        200: { description: 'Key rotated', content: { 'application/json': { schema: { type: 'object', properties: { publicKey: { type: 'string' }, rotatedAt: { type: 'string', format: 'date-time' }, source: { type: 'string' } } } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/metrics': {
    get: {
      tags: ['System'],
      summary: 'Prometheus metrics',
      responses: {
        200: { description: 'Plain-text Prometheus metrics', content: { 'text/plain': { schema: { type: 'string' } } } },
      },
    },
  },
};

const definition = {
  openapi: '3.0.0',
  info: {
    title: 'Stellar Royalty Splitter API',
    version: '1.0.0',
    description: 'On-chain royalty distribution API for NFT collaborators on Stellar',
  },
  servers: [
    { url: '/api/v1', description: 'API v1' },
    { url: '/', description: 'Root' },
  ],
  tags: [
    { name: 'Contract', description: 'Contract initialization and state' },
    { name: 'Distribution', description: 'Primary sale distribution' },
    { name: 'Collaborators', description: 'Collaborator management' },
    { name: 'Secondary Royalty', description: 'Secondary market royalties' },
    { name: 'Transactions', description: 'Transaction lookup and confirmation' },
    { name: 'History', description: 'Distribution history' },
    { name: 'Audit', description: 'Audit log' },
    { name: 'Webhooks', description: 'Event webhooks' },
    { name: 'Analytics', description: 'Analytics and reporting' },
    { name: 'Admin', description: 'Admin operations' },
    { name: 'System', description: 'Health and metrics' },
  ],
  components: {
    ...components,
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
  },
  paths: { ...paths1, ...paths2, ...paths3 },
};

export const swaggerSpec = swaggerJsdoc({ definition, apis: [] });
export const swaggerUiOptions = { customSiteTitle: 'Stellar Royalty Splitter API Docs' };
