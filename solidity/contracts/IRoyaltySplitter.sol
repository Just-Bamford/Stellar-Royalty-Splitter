// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRoyaltySplitter
 * @dev Interface for cross-chain royalty splitter
 */
interface IRoyaltySplitter {
    function initialize(address[] calldata _collaborators, uint256[] calldata _shares, uint256 _royaltyRate) external;
    function distribute(address _token, uint256 _amount) external;
    function setRoyaltyRate(uint256 _newRate) external;
    function pause() external;
    function unpause() external;
    function syncChainState(uint256 _chainId, address _contractAddress, uint256 _royaltyRate) external;
    function linkPool(address _poolAddress, uint256 _shareWeight) external;
    function unlinkPool(address _poolAddress) external;
    function addCollaborator(address _collaborator, uint256 _share) external;
    function removeCollaborator(address _collaborator) external;
}
