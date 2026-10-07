// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CrossChainStateSync
 * @dev Manages state synchronization across multiple chains
 * Allows consistent royalty rates and settings across deployed contracts
 */
contract CrossChainStateSync is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // Maximum number of chains that can be synced
    uint256 public constant MAX_CHAINS = 10;

    // Minimum delay between syncs (prevent spam)
    uint256 public constant SYNC_DELAY = 1 hours;

    struct ChainConfig {
        uint256 chainId;
        address contractAddress;
        uint256 lastSync;
        uint256 royaltyRate;
        bool active;
    }

    mapping(uint256 => ChainConfig) public chainConfigs;
    uint256 public chainCount;

    // Sync history
    struct SyncEvent {
        uint256 chainId;
        uint256 royaltyRate;
        uint256 timestamp;
        address initiator;
    }

    SyncEvent[] public syncHistory;

    event ChainRegistered(uint256 indexed chainId, address contractAddress);
    event ChainUnregistered(uint256 indexed chainId);
    event StateSynced(uint256 indexed chainId, uint256 royaltyRate, address indexed initiator);
    event RoyaltyRateUpdated(uint256 indexed chainId, uint256 oldRate, uint256 newRate);

    error ChainAlreadyRegistered();
    error ChainNotRegistered();
    error MaxChainsReached();
    error SyncTooFrequent();
    error InvalidChainId();
    error InvalidRoyaltyRate();

    modifier onlyRegisteredChain(uint256 _chainId) {
        if (!chainConfigs[_chainId].active) revert ChainNotRegistered();
        _;
    }

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, msg.sender);
    }

    /**
     * @dev Register a new chain for state sync
     */
    function registerChain(uint256 _chainId, address _contractAddress) external onlyRole(ADMIN_ROLE) {
        if (_chainId == 0) revert InvalidChainId();
        if (chainConfigs[_chainId].active) revert ChainAlreadyRegistered();
        if (chainCount >= MAX_CHAINS) revert MaxChainsReached();

        chainConfigs[_chainId] = ChainConfig({
            chainId: _chainId,
            contractAddress: _contractAddress,
            lastSync: 0,
            royaltyRate: 0,
            active: true
        });

        chainCount++;

        emit ChainRegistered(_chainId, _contractAddress);
    }

    /**
     * @dev Unregister a chain from state sync
     */
    function unregisterChain(uint256 _chainId) external onlyRole(ADMIN_ROLE) onlyRegisteredChain(_chainId) {
        chainConfigs[_chainId].active = false;
        chainCount--;

        emit ChainUnregistered(_chainId);
    }

    /**
     * @dev Sync royalty rate across all registered chains
     */
    function syncRoyaltyRate(uint256 _newRate) external onlyRole(ORACLE_ROLE) nonReentrant {
        if (_newRate == 0 || _newRate > 10000) revert InvalidRoyaltyRate();

        for (uint256 i = 0; i < chainCount; i++) {
            // In a real implementation, this would call cross-chain messaging
            // For now, we just update the local state
            uint256 chainId = _getChainIdByIndex(i);
            if (chainConfigs[chainId].active) {
                uint256 oldRate = chainConfigs[chainId].royaltyRate;
                chainConfigs[chainId].royaltyRate = _newRate;
                chainConfigs[chainId].lastSync = block.timestamp;

                emit RoyaltyRateUpdated(chainId, oldRate, _newRate);
                emit StateSynced(chainId, _newRate, msg.sender);

                // Record sync history
                syncHistory.push(SyncEvent({
                    chainId: chainId,
                    royaltyRate: _newRate,
                    timestamp: block.timestamp,
                    initiator: msg.sender
                }));
            }
        }
    }

    /**
     * @dev Sync royalty rate for a specific chain
     */
    function syncChainRoyaltyRate(uint256 _chainId, uint256 _newRate) external onlyRole(ORACLE_ROLE) onlyRegisteredChain(_chainId) nonReentrant {
        if (block.timestamp - chainConfigs[_chainId].lastSync < SYNC_DELAY) revert SyncTooFrequent();
        if (_newRate == 0 || _newRate > 10000) revert InvalidRoyaltyRate();

        uint256 oldRate = chainConfigs[_chainId].royaltyRate;
        chainConfigs[_chainId].royaltyRate = _newRate;
        chainConfigs[_chainId].lastSync = block.timestamp;

        emit RoyaltyRateUpdated(_chainId, oldRate, _newRate);
        emit StateSynced(_chainId, _newRate, msg.sender);

        // Record sync history
        syncHistory.push(SyncEvent({
            chainId: _chainId,
            royaltyRate: _newRate,
            timestamp: block.timestamp,
            initiator: msg.sender
        }));
    }

    /**
     * @dev Get chain configuration
     */
    function getChainConfig(uint256 _chainId) external view returns (ChainConfig memory) {
        return chainConfigs[_chainId];
    }

    /**
     * @dev Get all registered chain IDs
     */
    function getRegisteredChains() external view returns (uint256[] memory) {
        uint256[] memory chainIds = new uint256[](chainCount);
        uint256 index = 0;

        for (uint256 i = 0; i < chainCount; i++) {
            uint256 chainId = _getChainIdByIndex(i);
            if (chainConfigs[chainId].active) {
                chainIds[index] = chainId;
                index++;
            }
        }

        return chainIds;
    }

    /**
     * @dev Get sync history
     */
    function getSyncHistory(uint256 _offset, uint256 _limit) external view returns (SyncEvent[] memory) {
        if (_offset >= syncHistory.length) {
            return new SyncEvent[](0);
        }

        uint256 end = _offset + _limit;
        if (end > syncHistory.length) {
            end = syncHistory.length;
        }

        uint256 length = end - _offset;
        SyncEvent[] memory result = new SyncEvent[](length);

        for (uint256 i = 0; i < length; i++) {
            result[i] = syncHistory[_offset + i];
        }

        return result;
    }

    /**
     * @dev Helper to get chain ID by index
     */
    function _getChainIdByIndex(uint256 _index) internal view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 1; i <= type(uint256).max; i++) {
            if (chainConfigs[i].active) {
                if (count == _index) {
                    return i;
                }
                count++;
            }
        }
        revert ChainNotRegistered();
    }
}
