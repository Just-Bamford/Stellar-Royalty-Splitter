# Stellar Royalty Splitter - Solidity Contracts

This directory contains Solidity smart contracts for multi-chain deployment of the Stellar Royalty Splitter on Ethereum, Polygon, and Arbitrum.

## Overview

The Solidity contracts provide feature parity with the existing Soroban (Stellar) implementation, enabling royalty splitting across multiple EVM-compatible chains.

## Contracts

### RoyaltySplitter.sol
Main royalty splitter contract with the following features:
- Multi-admin access control
- Collaborator management with share-based distribution
- Royalty rate configuration and history tracking
- Cross-chain state synchronization
- Pool linking for complex distribution patterns
- Vesting schedules for collaborator shares
- Incentive bonuses (early adopter and activity-based)
- Emergency pause functionality
- Distribution history and audit trail

### IRoyaltySplitter.sol
Interface for cross-chain compatibility and external integrations.

### MockERC20.sol
Mock ERC20 token for testing purposes.

## Installation

```bash
cd solidity
npm install
```

## Configuration

1. Copy `.env.example` to `.env`
2. Fill in your RPC URLs and API keys
3. Ensure you have a private key with sufficient funds for deployment

## Testing

```bash
npm test
```

## Deployment

### Ethereum Mainnet
```bash
npm run deploy:ethereum
```

### Ethereum Goerli Testnet
```bash
npm run deploy:ethereum:testnet
```

### Polygon Mainnet
```bash
npm run deploy:polygon
```

### Polygon Mumbai Testnet
```bash
npm run deploy:polygon:testnet
```

### Arbitrum Mainnet
```bash
npm run deploy:arbitrum
```

### Arbitrum Goerli Testnet
```bash
npm run deploy:arbitrum:testnet
```

## Cross-Chain State Sync

The contract supports state synchronization across chains:

```solidity
function syncChainState(
    uint256 _chainId,
    address _contractAddress,
    uint256 _royaltyRate
) external onlyRole(ADMIN_ROLE)
```

This allows maintaining consistent royalty rates and settings across all deployed chains.

## Gas Optimization

The contracts are optimized for gas efficiency:
- Storage packing where possible
- Event emission for off-chain indexing
- Batch operations support
- Optimized Solidity compiler settings (200 runs)

## Security

- Access control via OpenZeppelin's AccessControl
- Reentrancy protection
- Pausable functionality
- Emergency pause by authorized signers
- Input validation and overflow protection

## License

MIT
