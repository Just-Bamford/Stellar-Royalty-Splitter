// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/**
 * @title RoyaltySplitter
 * @dev Multi-chain royalty splitter contract with feature parity to Soroban version
 * Supports Ethereum, Polygon, and Arbitrum deployments
 */
contract RoyaltySplitter is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Roles
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    // Constants
    uint256 public constant MAX_COLLABORATORS = 10;
    uint256 public constant MAX_RECIPIENTS = 10;
    uint256 public constant MAX_ADMIN_LIST = 10;
    uint256 public constant MAX_APPROVED_TOKENS = 25;
    uint256 public constant MAX_ROYALTY_TIERS = 20;
    uint256 public constant MAX_LINKED_POOLS = 5;
    uint256 public constant RATE_HISTORY_CAP = 20;
    uint256 public constant DISTRIBUTION_HISTORY_LIMIT = 500;
    uint256 public constant TOTAL_SHARE_WEIGHT = 10000;
    uint256 public constant MAX_SECONDARY_POOL_SIZE = 1_000_000_000_000;
    uint256 public constant DEFAULT_ADMIN_ROTATION_TIMELOCK = 48 hours;
    uint256 public constant MIN_ADMIN_ROTATION_TIMELOCK = 1 hours;
    uint256 public constant MAX_ADMIN_ROTATION_TIMELOCK = 30 days;
    uint256 public constant EARLY_ADOPTER_WINDOW = 30 days;
    uint256 public constant EARLY_ADOPTER_BONUS_BPS = 50;
    uint256 public constant ACTIVITY_BONUS_BPS_PER_STEP = 10;
    uint256 public constant ACTIVITY_BONUS_STEP = 100;
    uint256 public constant ACTIVITY_BONUS_MAX_STEPS = 10;
    uint256 public constant MAX_INDIVIDUAL_INCENTIVE_BPS = 1000;
    uint256 public constant MAX_TOTAL_INCENTIVE_BPS = 2000;
    uint256 public constant TIER_DEGRADE_RESALE_COUNT_2ND = 2;
    uint256 public constant TIER_DEGRADE_RESALE_COUNT_4TH = 4;
    uint256 public constant TIER_DEGRADE_BPS_2ND = 5000;
    uint256 public constant TIER_DEGRADE_BPS_4TH = 2500;
    uint256 public constant TIER_TIME_DEGRADE_AGE = 90 days;
    uint256 public constant TIER_TIME_DEGRADE_BPS = 5000;

    // State variables
    bool public initialized;
    uint256 public royaltyRate; // basis points
    uint256 public lastDistribution;
    uint256 public lastSecondaryDistribution;
    uint256 public adminRotationTimelock;
    uint256 public maxSecondaryPoolSize;
    uint256 public anomalyThreshold;
    bool public incentivesEnabled;
    bool public emergencyPaused;
    uint256 public adminThreshold;
    uint256 public emergencyPauseThreshold;
    uint256 public distributionRecordCount;
    uint256 public proposalCount;
    uint256 public operationProposalCount;

    // Secondary pool
    address public secondaryPool;
    address public secondaryToken;
    uint256 public secondaryPoolBalance;

    // Oracle configuration
    address public oracleSource;
    uint256 public oracleUpdateFrequency;
    uint256 public oracleMaxStaleness;
    uint256 public oracleLastUpdated;

    // Pending admin rotation
    address public pendingAdmin;
    uint256 public adminRotationInitiatedAt;

    // Cross-chain state sync
    mapping(uint256 => ChainState) public chainStates;
    uint256 public linkedChainCount;

    // Storage
    address[] public collaborators;
    mapping(address => uint256) public shares;
    mapping(address => Recipient) public defaultRecipients;
    mapping(address => bool) public approvedTokens;
    mapping(address => uint256) public tokenFeeOverrides;
    mapping(address => uint256) public feePools;
    mapping(address => RoyaltyTier[]) public royaltyTiers;
    mapping(address => uint256) public resaleCounts;
    mapping(address => uint256) public nftFirstSeen;
    mapping(address => VestingSchedule) public vestingSchedules;
    mapping(address => uint256) public govBalances;
    mapping(address => uint256) public stakedGov;
    mapping(address => uint256) public recipientEarnings;
    mapping(address => uint256) public joinDates;
    mapping(address => uint256) public activityCounts;

    // Admin list
    address[] public adminList;
    mapping(address => bool) public isAdmin;

    // Emergency pause signers
    address[] public emergencyPauseSigners;
    mapping(address => bool) public isEmergencySigner;

    // History
    RoyaltyRateChange[] public royaltyRateHistory;
    DistributionRecord[] public distributionRecords;
    Dispute[] public disputes;
    Proposal[] public proposals;
    OperationProposal[] public operationProposals;

    // Operation pause states
    bool public pausedPrimary;
    bool public pausedSecondary;

    // Metadata binding
    MetadataBinding public metadataBinding;

    // Linked pools
    LinkedPool[] public linkedPools;

    // Structs
    struct Recipient {
        address recipient;
        uint256 share;
    }

    struct RoyaltyTier {
        string rarity;
        uint256 rateBps;
        string description;
    }

    struct VestingSchedule {
        address beneficiary;
        uint256 totalShares;
        uint256 cliffDays;
        uint256 vestingDays;
        uint256 startTime;
        uint256 claimedShares;
    }

    struct RoyaltyRateChange {
        uint256 oldRate;
        uint256 newRate;
        uint256 timestamp;
        address caller;
    }

    struct DistributionRecord {
        uint256 id;
        address token;
        uint256 totalAmount;
        uint256 recipientCount;
        uint256 timestamp;
        string status;
    }

    struct Dispute {
        uint256 transactionId;
        string reason;
        uint256 amount;
        DisputeStatus status;
        address openedBy;
        uint256 openedAt;
        uint256 resolvedAt;
    }

    struct Proposal {
        uint256 id;
        ProposalKind kind;
        uint256 newRate;
        address proposer;
        uint256 createdAt;
        uint256 deadline;
        uint256 yesWeight;
        uint256 noWeight;
        bool executed;
        bool rejected;
    }

    struct OperationProposal {
        uint256 id;
        SensitiveOperation operation;
        address proposer;
        uint256 createdAt;
        uint256 deadline;
        uint256 threshold;
        uint256 approvalsCount;
        bool executed;
        uint256 executedAt;
    }

    struct ChainState {
        uint256 chainId;
        uint256 royaltyRate;
        uint256 lastSync;
        address contractAddress;
    }

    struct MetadataBinding {
        address collection;
        uint256 tokenId;
        bool bound;
    }

    struct LinkedPool {
        address poolAddress;
        uint256 shareWeight;
    }

    enum DisputeStatus {
        Open,
        Resolved,
        ClawedBack
    }

    enum ProposalKind {
        RoyaltyRateChange
    }

    enum SensitiveOperation {
        Pause,
        Unpause,
        PausePrimary,
        UnpausePrimary,
        PauseSecondary,
        UnpauseSecondary,
        TransferAdmin,
        SetRoyaltyRate,
        SetAnomalyThreshold,
        SetIncentivesEnabled,
        UpdateWasm,
        SetApprovedTokens
    }

    // Events
    event Initialized(address indexed admin, uint256 royaltyRate);
    event CollaboratorAdded(address indexed collaborator, uint256 share);
    event CollaboratorRemoved(address indexed collaborator);
    event SharesUpdated(address indexed collaborator, uint256 oldShare, uint256 newShare);
    event RoyaltyRateChanged(uint256 oldRate, uint256 newRate, address indexed caller);
    event Distributed(address indexed token, uint256 totalAmount, uint256 recipientCount);
    event SecondaryDistributed(address indexed token, uint256 amount);
    event DisputeOpened(uint256 indexed disputeId, uint256 transactionId, address indexed openedBy);
    event DisputeResolved(uint256 indexed disputeId, address indexed resolver);
    event ProposalCreated(uint256 indexed proposalId, ProposalKind kind);
    event ProposalExecuted(uint256 indexed proposalId);
    event ChainStateSynced(uint256 chainId, uint256 royaltyRate);
    event PoolLinked(address indexed poolAddress, uint256 shareWeight);
    event PoolUnlinked(address indexed poolAddress);
    event VestingScheduleCreated(address indexed beneficiary, uint256 totalShares);
    event VestingSharesClaimed(address indexed beneficiary, uint256 claimedShares);

    // Errors
    error Underfunded();
    error AlreadyInitialized();
    error EmptyCollaborators();
    error TooManyRecipients();
    error LengthMismatch();
    error InvalidShareTotal();
    error ZeroShare();
    error DuplicateRecipient();
    error InvalidBasisPoints();
    error NotInitialized();
    error NoCollaborators();
    error NoShareMap();
    error ArithmeticOverflow();
    error RoyaltyRateZero();
    error RoyaltyRateTooHigh();
    error ContractPaused();
    error AmountNotPositive();
    error InsufficientBalance();
    error EmptyRecipients();
    error AmountTooSmall();
    error PoolExceedsBalance();
    error NoSecondaryRoyalties();
    error NoSecondaryToken();
    error CollaboratorNotFound();
    error InvalidUpdatedShareTotal();
    error SalePriceNotPositive();
    error InputTooLarge();
    error NoBalance();
    error NoInitializationCommitment();
    error InitRevealTooEarly();
    error InitCommitmentMismatch();
    error TooManyBatchTokens();
    error RoyaltyAmountNotPositive();
    error NoPendingAdminRotation();
    error AdminRotationTimelockNotElapsed();
    error InvalidTimelockDuration();
    error EmergencyContractPaused();
    error InvalidAnomalyThreshold();
    error TokenNotApproved();
    error DisputeNotFound();
    error DisputeAlreadyResolved();
    error ProposalNotFound();
    error ProposalVotingClosed();
    error ProposalStillOpen();
    error ProposalAlreadyExecuted();
    error AlreadyVoted();
    error InvalidProposalDuration();
    error InvalidEmergencyPauseSigners();
    error InvalidEmergencyPauseThreshold();
    error UnauthorizedEmergencySigner();
    error NoMetadataBinding();
    error PoolAlreadyLinked();
    error InvalidLinkedPool();
    error InvalidLinkedShareTotal();
    error TooManyLinkedPools();
    error PoolNotLinked();
    error FeeOverrideTooHigh();

    // Modifiers
    modifier onlyInitialized() {
        if (!initialized) revert NotInitialized();
        _;
    }

    modifier whenNotEmergencyPaused() {
        if (emergencyPaused) revert EmergencyContractPaused();
        _;
    }

    modifier onlyEmergencySigner() {
        if (!isEmergencySigner[msg.sender]) revert UnauthorizedEmergencySigner();
        _;
    }

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(EMERGENCY_ROLE, msg.sender);
        adminRotationTimelock = DEFAULT_ADMIN_ROTATION_TIMELOCK;
        maxSecondaryPoolSize = MAX_SECONDARY_POOL_SIZE;
        incentivesEnabled = true;
        adminThreshold = 1;
        emergencyPauseThreshold = 1;
    }

    /**
     * @dev Initialize the contract with collaborators and royalty rate
     */
    function initialize(
        address[] calldata _collaborators,
        uint256[] calldata _shares,
        uint256 _royaltyRate
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (initialized) revert AlreadyInitialized();
        if (_collaborators.length == 0) revert EmptyCollaborators();
        if (_collaborators.length > MAX_COLLABORATORS) revert InputTooLarge();
        if (_collaborators.length != _shares.length) revert LengthMismatch();
        if (_royaltyRate == 0) revert RoyaltyRateZero();
        if (_royaltyRate > 10000) revert RoyaltyRateTooHigh();

        uint256 totalShares = 0;
        for (uint256 i = 0; i < _collaborators.length; i++) {
            if (_shares[i] == 0) revert ZeroShare();
            if (shares[_collaborators[i]] > 0) revert DuplicateRecipient();
            
            collaborators.push(_collaborators[i]);
            shares[_collaborators[i]] = _shares[i];
            totalShares += _shares[i];
            joinDates[_collaborators[i]] = block.timestamp;
        }

        if (totalShares != TOTAL_SHARE_WEIGHT) revert InvalidShareTotal();

        royaltyRate = _royaltyRate;
        initialized = true;

        emit Initialized(msg.sender, _royaltyRate);
    }

    /**
     * @dev Distribute royalties to collaborators
     */
    function distribute(address _token, uint256 _amount) external nonReentrant onlyInitialized whenNotPaused whenNotEmergencyPaused {
        if (_amount == 0) revert AmountNotPositive();
        if (collaborators.length == 0) revert NoCollaborators();

        IERC20 token = IERC20(_token);
        uint256 balance = token.balanceOf(address(this));
        if (balance < _amount) revert InsufficientBalance();

        // Calculate protocol fee
        uint256 protocolFee = (_amount * royaltyRate) / 10000;
        uint256 distributableAmount = _amount - protocolFee;

        // Update fee pool
        feePools[_token] += protocolFee;

        // Distribute to collaborators
        uint256 totalDistributed = 0;
        for (uint256 i = 0; i < collaborators.length; i++) {
            address collaborator = collaborators[i];
            uint256 share = shares[collaborator];
            uint256 incentiveBonus = calculateIncentiveBonus(collaborator);
            uint256 effectiveShare = share + incentiveBonus;
            uint256 amount = (distributableAmount * effectiveShare) / TOTAL_SHARE_WEIGHT;

            if (amount > 0) {
                token.safeTransfer(collaborator, amount);
                recipientEarnings[collaborator] += amount;
                totalDistributed += amount;
            }
        }

        lastDistribution = block.timestamp;

        // Record distribution
        _recordDistribution(_token, _amount, collaborators.length);

        emit Distributed(_token, _amount, collaborators.length);
    }

    /**
     * @dev Calculate incentive bonus for a collaborator
     */
    function calculateIncentiveBonus(address _collaborator) public view returns (uint256) {
        if (!incentivesEnabled) return 0;

        uint256 joinDate = joinDates[_collaborator];
        uint256 activityCount = activityCounts[_collaborator];

        // Early adopter bonus
        uint256 earlyAdopterBonus = 0;
        if (block.timestamp - joinDate < EARLY_ADOPTER_WINDOW) {
            earlyAdopterBonus = EARLY_ADOPTER_BONUS_BPS;
        }

        // Activity bonus
        uint256 activityBonus = 0;
        uint256 steps = activityCount / ACTIVITY_BONUS_STEP;
        if (steps > ACTIVITY_BONUS_MAX_STEPS) {
            steps = ACTIVITY_BONUS_MAX_STEPS;
        }
        activityBonus = steps * ACTIVITY_BONUS_BPS_PER_STEP;

        uint256 totalBonus = earlyAdopterBonus + activityBonus;
        if (totalBonus > MAX_INDIVIDUAL_INCENTIVE_BPS) {
            totalBonus = MAX_INDIVIDUAL_INCENTIVE_BPS;
        }

        return totalBonus;
    }

    /**
     * @dev Record distribution in history
     */
    function _recordDistribution(address _token, uint256 _amount, uint256 _recipientCount) internal {
        DistributionRecord memory record = DistributionRecord({
            id: distributionRecordCount,
            token: _token,
            totalAmount: _amount,
            recipientCount: _recipientCount,
            timestamp: block.timestamp,
            status: "completed"
        });

        distributionRecords.push(record);
        distributionRecordCount++;

        // Trim history if exceeds limit
        if (distributionRecords.length > DISTRIBUTION_HISTORY_LIMIT) {
            // Remove oldest record (FIFO)
            for (uint256 i = 0; i < distributionRecords.length - 1; i++) {
                distributionRecords[i] = distributionRecords[i + 1];
            }
            distributionRecords.pop();
        }
    }

    /**
     * @dev Set incentives enabled
     */
    function setIncentivesEnabled(bool _enabled) external onlyRole(ADMIN_ROLE) onlyInitialized {
        incentivesEnabled = _enabled;
    }

    /**
     * @dev Set royalty rate
     */
    function setRoyaltyRate(uint256 _newRate) external onlyRole(ADMIN_ROLE) onlyInitialized {
        if (_newRate == 0) revert RoyaltyRateZero();
        if (_newRate > 10000) revert RoyaltyRateTooHigh();

        uint256 oldRate = royaltyRate;
        royaltyRate = _newRate;

        // Record rate change
        RoyaltyRateChange memory change = RoyaltyRateChange({
            oldRate: oldRate,
            newRate: _newRate,
            timestamp: block.timestamp,
            caller: msg.sender
        });

        royaltyRateHistory.push(change);

        // Trim history if exceeds cap
        if (royaltyRateHistory.length > RATE_HISTORY_CAP) {
            for (uint256 i = 0; i < royaltyRateHistory.length - 1; i++) {
                royaltyRateHistory[i] = royaltyRateHistory[i + 1];
            }
            royaltyRateHistory.pop();
        }

        emit RoyaltyRateChanged(oldRate, _newRate, msg.sender);
    }

    /**
     * @dev Pause contract
     */
    function pause() external onlyRole(ADMIN_ROLE) onlyInitialized {
        _pause();
    }

    /**
     * @dev Unpause contract
     */
    function unpause() external onlyRole(ADMIN_ROLE) onlyInitialized {
        _unpause();
    }

    /**
     * @dev Emergency pause by emergency signers
     */
    function emergencyPause() external onlyEmergencySigner {
        uint256 signersCount = 0;
        for (uint256 i = 0; i < emergencyPauseSigners.length; i++) {
            if (isEmergencySigner[emergencyPauseSigners[i]]) {
                signersCount++;
            }
        }

        if (signersCount < emergencyPauseThreshold) revert InvalidEmergencyPauseThreshold();

        emergencyPaused = true;
        _pause();
    }

    /**
     * @dev Sync state across chains
     */
    function syncChainState(uint256 _chainId, address _contractAddress, uint256 _royaltyRate) external onlyRole(ADMIN_ROLE) onlyInitialized {
        chainStates[_chainId] = ChainState({
            chainId: _chainId,
            royaltyRate: _royaltyRate,
            lastSync: block.timestamp,
            contractAddress: _contractAddress
        });

        if (chainStates[_chainId].chainId == 0) {
            linkedChainCount++;
        }

        emit ChainStateSynced(_chainId, _royaltyRate);
    }

    /**
     * @dev Link another royalty splitter pool
     */
    function linkPool(address _poolAddress, uint256 _shareWeight) external onlyRole(ADMIN_ROLE) onlyInitialized {
        if (_poolAddress == address(this)) revert InvalidLinkedPool();
        if (linkedPools.length >= MAX_LINKED_POOLS) revert TooManyLinkedPools();

        // Check if already linked
        for (uint256 i = 0; i < linkedPools.length; i++) {
            if (linkedPools[i].poolAddress == _poolAddress) revert PoolAlreadyLinked();
        }

        linkedPools.push(LinkedPool({
            poolAddress: _poolAddress,
            shareWeight: _shareWeight
        }));

        emit PoolLinked(_poolAddress, _shareWeight);
    }

    /**
     * @dev Unlink a pool
     */
    function unlinkPool(address _poolAddress) external onlyRole(ADMIN_ROLE) onlyInitialized {
        bool found = false;
        uint256 index = 0;

        for (uint256 i = 0; i < linkedPools.length; i++) {
            if (linkedPools[i].poolAddress == _poolAddress) {
                found = true;
                index = i;
                break;
            }
        }

        if (!found) revert PoolNotLinked();

        // Remove from array
        for (uint256 i = index; i < linkedPools.length - 1; i++) {
            linkedPools[i] = linkedPools[i + 1];
        }
        linkedPools.pop();

        emit PoolUnlinked(_poolAddress);
    }

    /**
     * @dev Add collaborator
     */
    function addCollaborator(address _collaborator, uint256 _share) external onlyRole(ADMIN_ROLE) onlyInitialized {
        if (collaborators.length >= MAX_COLLABORATORS) revert InputTooLarge();
        if (_share == 0) revert ZeroShare();
        if (shares[_collaborator] > 0) revert DuplicateRecipient();

        // Check if total shares would exceed limit
        uint256 currentTotal = 0;
        for (uint256 i = 0; i < collaborators.length; i++) {
            currentTotal += shares[collaborators[i]];
        }
        if (currentTotal + _share > TOTAL_SHARE_WEIGHT) revert InvalidShareTotal();

        collaborators.push(_collaborator);
        shares[_collaborator] = _share;
        joinDates[_collaborator] = block.timestamp;

        emit CollaboratorAdded(_collaborator, _share);
    }

    /**
     * @dev Remove collaborator
     */
    function removeCollaborator(address _collaborator) external onlyRole(ADMIN_ROLE) onlyInitialized {
        if (shares[_collaborator] == 0) revert CollaboratorNotFound();

        // Remove from array
        bool found = false;
        uint256 index = 0;
        for (uint256 i = 0; i < collaborators.length; i++) {
            if (collaborators[i] == _collaborator) {
                found = true;
                index = i;
                break;
            }
        }

        if (!found) revert CollaboratorNotFound();

        for (uint256 i = index; i < collaborators.length - 1; i++) {
            collaborators[i] = collaborators[i + 1];
        }
        collaborators.pop();

        delete shares[_collaborator];

        emit CollaboratorRemoved(_collaborator);
    }

    /**
     * @dev Create vesting schedule for a beneficiary
     */
    function createVestingSchedule(
        address _beneficiary,
        uint256 _totalShares,
        uint256 _cliffDays,
        uint256 _vestingDays
    ) external onlyRole(ADMIN_ROLE) onlyInitialized {
        if (_totalShares == 0) revert ZeroShare();
        if (_cliffDays == 0 || _vestingDays == 0) revert InvalidShareTotal();

        vestingSchedules[_beneficiary] = VestingSchedule({
            beneficiary: _beneficiary,
            totalShares: _totalShares,
            cliffDays: _cliffDays,
            vestingDays: _vestingDays,
            startTime: block.timestamp,
            claimedShares: 0
        });

        emit VestingScheduleCreated(_beneficiary, _totalShares);
    }

    /**
     * @dev Claim vested shares
     */
    function claimVestedShares(address _beneficiary) external onlyInitialized {
        VestingSchedule storage schedule = vestingSchedules[_beneficiary];
        if (schedule.beneficiary == address(0)) revert CollaboratorNotFound();

        uint256 vestedAmount = _calculateVestedShares(schedule);
        uint256 claimable = vestedAmount - schedule.claimedShares;

        if (claimable == 0) revert AmountNotPositive();

        schedule.claimedShares += claimable;

        emit VestingSharesClaimed(_beneficiary, claimable);
    }

    /**
     * @dev Calculate vested shares
     */
    function _calculateVestedShares(VestingSchedule memory _schedule) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - _schedule.startTime;
        uint256 cliffSeconds = _schedule.cliffDays * 1 days;
        uint256 vestingSeconds = _schedule.vestingDays * 1 days;

        if (elapsed < cliffSeconds) {
            return 0;
        }

        if (elapsed >= vestingSeconds) {
            return _schedule.totalShares;
        }

        uint256 vestingElapsed = elapsed - cliffSeconds;
        uint256 vestingPeriod = vestingSeconds - cliffSeconds;
        return (_schedule.totalShares * vestingElapsed) / vestingPeriod;
    }

    /**
     * @dev Get distribution history
     */
    function getDistributionHistory(uint256 _offset, uint256 _limit) external view returns (DistributionRecord[] memory) {
        if (_offset >= distributionRecords.length) {
            return new DistributionRecord[](0);
        }

        uint256 end = _offset + _limit;
        if (end > distributionRecords.length) {
            end = distributionRecords.length;
        }

        uint256 length = end - _offset;
        DistributionRecord[] memory result = new DistributionRecord[](length);

        for (uint256 i = 0; i < length; i++) {
            result[i] = distributionRecords[_offset + i];
        }

        return result;
    }

    /**
     * @dev Get royalty rate history
     */
    function getRoyaltyRateHistory() external view returns (RoyaltyRateChange[] memory) {
        return royaltyRateHistory;
    }

    /**
     * @dev Get collaborators
     */
    function getCollaborators() external view returns (address[] memory) {
        return collaborators;
    }

    /**
     * @dev Get linked pools
     */
    function getLinkedPools() external view returns (LinkedPool[] memory) {
        return linkedPools;
    }

    /**
     * @dev Get chain states
     */
    function getChainStates(uint256 _chainId) external view returns (ChainState memory) {
        return chainStates[_chainId];
    }
}
