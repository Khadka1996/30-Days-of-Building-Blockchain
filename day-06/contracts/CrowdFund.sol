// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title CrowdFund — crowdfunding campaigns with a goal, a deadline and safe refunds
/// @author Manish Khadka
/// @notice Anyone can launch a campaign with a goal (in wei) and a deadline.
///         Backers pledge ETH until the deadline. After the deadline:
///           - goal reached  -> the creator claims the money, exactly once;
///           - goal missed   -> every backer takes their own pledge back.
///         A creator can also cancel before the deadline, which opens refunds.
/// @dev    Refunds are "pull payments": each backer calls `refund` for their
///         own money. There is no loop over backers, so one backer that cannot
///         receive ETH (or a campaign with thousands of backers) can never
///         block anybody else's refund.
///         Accounting uses each campaign's own `pledged` total, never
///         `address(this).balance`, so campaigns cannot touch each other's money.
contract CrowdFund {
    struct Campaign {
        address creator;
        uint64 endAt;      // pledges allowed while block.timestamp < endAt
        bool claimed;      // creator already took the money
        bool cancelled;    // creator cancelled before the deadline
        uint256 goal;      // wei needed for success
        uint256 pledged;   // wei currently pledged (refunds lower it)
    }

    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 90 days; // money can never be locked for years

    /// @notice Number of campaigns launched; ids are 0, 1, 2 …
    uint256 public campaignCount;
    mapping(uint256 => Campaign) private _campaigns;
    /// @notice How much each backer has pledged to each campaign.
    mapping(uint256 => mapping(address => uint256)) public pledgeOf;

    bool private _locked;

    event Launched(uint256 indexed id, address indexed creator, uint256 goal, uint64 endAt);
    event Pledged(uint256 indexed id, address indexed backer, uint256 amount);
    event Unpledged(uint256 indexed id, address indexed backer, uint256 amount);
    event Cancelled(uint256 indexed id);
    event Claimed(uint256 indexed id, address indexed creator, uint256 amount);
    event Refunded(uint256 indexed id, address indexed backer, uint256 amount);

    error ZeroGoal();
    error BadDuration();
    error UnknownCampaign();
    error NotCreator();
    error ZeroAmount();
    error CampaignEnded();
    error CampaignNotEnded();
    error CampaignCancelled();
    error GoalNotReached();
    error GoalReached();
    error AlreadyClaimed();
    error NothingToRefund();
    error NotEnoughPledged();
    error TransferFailed();
    error Reentrancy();
    error DirectPaymentRejected();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    modifier exists(uint256 id) {
        if (id >= campaignCount) revert UnknownCampaign();
        _;
    }

    /// @notice Start a campaign that runs for `duration` seconds from now.
    function launch(uint256 goal, uint256 duration) external returns (uint256 id) {
        if (goal == 0) revert ZeroGoal();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        id = campaignCount++;
        uint64 endAt = uint64(block.timestamp + duration);
        _campaigns[id] = Campaign({
            creator: msg.sender,
            endAt: endAt,
            claimed: false,
            cancelled: false,
            goal: goal,
            pledged: 0
        });
        emit Launched(id, msg.sender, goal, endAt);
    }

    /// @notice Back a running campaign with the ETH sent.
    function pledge(uint256 id) external payable exists(id) {
        Campaign storage c = _campaigns[id];
        if (msg.value == 0) revert ZeroAmount();
        if (c.cancelled) revert CampaignCancelled();
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp >= c.endAt) revert CampaignEnded();
        c.pledged += msg.value;
        pledgeOf[id][msg.sender] += msg.value;
        emit Pledged(id, msg.sender, msg.value);
    }

    /// @notice Take back part of a pledge while the campaign is still running.
    function unpledge(uint256 id, uint256 amount) external exists(id) nonReentrant {
        Campaign storage c = _campaigns[id];
        if (amount == 0) revert ZeroAmount();
        if (c.cancelled) revert CampaignCancelled(); // use refund() instead
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp >= c.endAt) revert CampaignEnded();
        uint256 mine = pledgeOf[id][msg.sender];
        if (amount > mine) revert NotEnoughPledged();
        // Effects before the interaction.
        pledgeOf[id][msg.sender] = mine - amount;
        c.pledged -= amount;
        emit Unpledged(id, msg.sender, amount);
        // Money only ever goes to msg.sender. `call` forwards all gas so smart-contract
        // wallets can receive; state is already updated and nonReentrant blocks callbacks.
        // slither-disable-next-line low-level-calls
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice The creator stops the campaign before its deadline; backers can then refund.
    function cancel(uint256 id) external exists(id) {
        Campaign storage c = _campaigns[id];
        if (msg.sender != c.creator) revert NotCreator();
        if (c.cancelled) revert CampaignCancelled();
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp >= c.endAt) revert CampaignEnded();
        c.cancelled = true;
        emit Cancelled(id);
    }

    /// @notice After the deadline, if the goal was reached, the creator takes the money once.
    function claim(uint256 id) external exists(id) nonReentrant {
        Campaign storage c = _campaigns[id];
        if (msg.sender != c.creator) revert NotCreator();
        if (c.cancelled) revert CampaignCancelled();
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp < c.endAt) revert CampaignNotEnded();
        if (c.pledged < c.goal) revert GoalNotReached();
        if (c.claimed) revert AlreadyClaimed();
        // Effects before the interaction: mark claimed first, so it can never pay twice.
        c.claimed = true;
        uint256 amount = c.pledged;
        emit Claimed(id, msg.sender, amount);
        // Money only ever goes to msg.sender. `call` forwards all gas so smart-contract
        // wallets can receive; state is already updated and nonReentrant blocks callbacks.
        // slither-disable-next-line low-level-calls
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice If the goal was missed (or the campaign was cancelled), take your own pledge back.
    function refund(uint256 id) external exists(id) nonReentrant {
        Campaign storage c = _campaigns[id];
        if (!c.cancelled) {
            // solhint-disable-next-line not-rely-on-time
            if (block.timestamp < c.endAt) revert CampaignNotEnded();
            if (c.pledged >= c.goal) revert GoalReached();
        }
        uint256 amount = pledgeOf[id][msg.sender];
        if (amount == 0) revert NothingToRefund();
        // Effects before the interaction: zero the pledge first, so it can never refund twice.
        pledgeOf[id][msg.sender] = 0;
        c.pledged -= amount;
        emit Refunded(id, msg.sender, amount);
        // Money only ever goes to msg.sender. `call` forwards all gas so smart-contract
        // wallets can receive; state is already updated and nonReentrant blocks callbacks.
        // slither-disable-next-line low-level-calls
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Read a campaign.
    function getCampaign(uint256 id) external view exists(id) returns (Campaign memory) {
        return _campaigns[id];
    }

    /// @dev Plain ETH sent to the contract belongs to no campaign, so it is refused.
    receive() external payable {
        revert DirectPaymentRejected();
    }
}
