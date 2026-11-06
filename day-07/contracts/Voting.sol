// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Voting — simple on-chain polls with one vote per address and a deadline
/// @author Manish Khadka
/// @notice Anyone can create a poll with 2–10 options and a closing time.
///         Every address can vote ONCE per poll, only before the deadline, and
///         a vote can never be changed. After the deadline anyone can read the
///         result: a clear winner, a tie, or no votes.
/// @dev    Votes are public on a blockchain: anyone can see the running totals
///         and who voted for what. "One vote per address" is not "one vote per
///         person": one person can create many addresses (see QA.md, K-01).
contract Voting {
    /// @notice Where a poll is in its life. Computed from the clock, never stored.
    enum Status {
        None,       // no poll with this id
        Open,       // accepting votes (before the deadline)
        Ended,      // deadline reached, result is final
        Cancelled   // creator cancelled it before anyone voted
    }

    /// @notice What the final result looks like.
    enum Outcome {
        NoVotes,    // nobody voted
        Winner,     // one option has strictly the most votes
        Tie         // two or more options share the top score
    }

    struct Poll {
        address creator;
        uint64 deadline;     // unix seconds; voting is allowed while now < deadline
        bool cancelled;
        uint32 totalVotes;
        string question;
        string[] options;
        uint32[] votes;      // votes[i] = votes for options[i]
    }

    /// @notice A read-only copy of a poll, returned by getPoll.
    struct PollView {
        address creator;
        string question;
        string[] options;
        uint32[] votes;
        uint64 deadline;
        uint32 totalVotes;
        Status currentStatus;
    }

    uint256 public constant MIN_OPTIONS = 2;
    uint256 public constant MAX_OPTIONS = 10;          // keeps every loop small and cheap
    uint256 public constant MAX_QUESTION_LENGTH = 200; // bytes
    uint256 public constant MAX_OPTION_LENGTH = 50;    // bytes
    uint256 public constant MIN_DURATION = 5 minutes;
    uint256 public constant MAX_DURATION = 30 days;    // also catches deadlines typed in milliseconds

    /// @notice Number of polls created. Poll ids run from 1 to pollCount.
    uint256 public pollCount;

    mapping(uint256 => Poll) private _polls;
    mapping(uint256 => mapping(address => bool)) private _hasVoted;

    event PollCreated(uint256 indexed pollId, address indexed creator, string question, uint256 optionCount, uint64 deadline);
    event Voted(uint256 indexed pollId, address indexed voter, uint256 indexed option);
    event PollCancelled(uint256 indexed pollId);

    error EmptyQuestion();
    error QuestionTooLong(uint256 length);
    error BadOptionCount(uint256 count);
    error EmptyOption(uint256 index);
    error OptionTooLong(uint256 index, uint256 length);
    error BadDeadline(uint64 deadline, uint256 earliest, uint256 latest);
    error PollNotFound(uint256 pollId);
    error NotCreator(uint256 pollId);
    error PollNotOpen(uint256 pollId, Status status);
    error AlreadyVoted(uint256 pollId, address voter);
    error InvalidOption(uint256 option, uint256 optionCount);
    error CannotCancelAfterVotes(uint256 pollId, uint256 totalVotes);
    error ResultNotReady(uint256 pollId, Status status);

    /// @dev The poll id must point at a poll that was created.
    modifier pollExists(uint256 pollId) {
        if (pollId == 0 || pollId > pollCount) revert PollNotFound(pollId);
        _;
    }

    /// @dev Only the address that created the poll.
    modifier onlyCreator(uint256 pollId) {
        if (msg.sender != _polls[pollId].creator) revert NotCreator(pollId);
        _;
    }

    /// @dev The poll must be accepting votes: not cancelled and before the deadline.
    modifier onlyOpen(uint256 pollId) {
        Status s = status(pollId);
        if (s != Status.Open) revert PollNotOpen(pollId, s);
        _;
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    /// @notice Create a poll.
    /// @param question  What people are voting on (1–200 bytes).
    /// @param options   2–10 answers, each 1–50 bytes.
    /// @param deadline  Unix time (seconds) when voting closes: 5 minutes to 30 days from now.
    /// @return pollId   The new poll's id (starts at 1).
    function createPoll(string calldata question, string[] calldata options, uint64 deadline)
        external
        returns (uint256 pollId)
    {
        uint256 qLen = bytes(question).length;
        if (qLen == 0) revert EmptyQuestion();
        if (qLen > MAX_QUESTION_LENGTH) revert QuestionTooLong(qLen);

        uint256 n = options.length;
        if (n < MIN_OPTIONS || n > MAX_OPTIONS) revert BadOptionCount(n);

        // Deadlines are measured in minutes and days, so the few seconds a
        // validator can shift block.timestamp do not matter here.
        uint256 earliest = block.timestamp + MIN_DURATION;
        uint256 latest = block.timestamp + MAX_DURATION;
        // slither-disable-next-line timestamp
        if (deadline < earliest || deadline > latest) revert BadDeadline(deadline, earliest, latest);

        pollId = ++pollCount;
        Poll storage p = _polls[pollId];
        p.creator = msg.sender;
        p.deadline = deadline;
        p.question = question;
        for (uint256 i = 0; i < n; ++i) {
            uint256 len = bytes(options[i]).length;
            if (len == 0) revert EmptyOption(i);
            if (len > MAX_OPTION_LENGTH) revert OptionTooLong(i, len);
            p.options.push(options[i]);
            p.votes.push(0);
        }

        emit PollCreated(pollId, msg.sender, question, n, deadline);
    }

    /// @notice Vote for one option. One vote per address per poll, before the deadline, final.
    /// @param option Index of the option (0 = first option).
    function vote(uint256 pollId, uint256 option) external pollExists(pollId) onlyOpen(pollId) {
        if (_hasVoted[pollId][msg.sender]) revert AlreadyVoted(pollId, msg.sender);
        Poll storage p = _polls[pollId];
        if (option >= p.options.length) revert InvalidOption(option, p.options.length);

        _hasVoted[pollId][msg.sender] = true;
        p.votes[option] += 1;
        p.totalVotes += 1;

        emit Voted(pollId, msg.sender, option);
    }

    /// @notice The creator can cancel a poll, but only while it is open and
    ///         BEFORE anyone has voted. Once votes exist, a creator who sees
    ///         their side losing must not be able to throw the poll away.
    function cancelPoll(uint256 pollId) external pollExists(pollId) onlyCreator(pollId) onlyOpen(pollId) {
        Poll storage p = _polls[pollId];
        if (p.totalVotes != 0) revert CannotCancelAfterVotes(pollId, p.totalVotes);
        p.cancelled = true;
        emit PollCancelled(pollId);
    }

    // ---------------------------------------------------------------------
    // Reading
    // ---------------------------------------------------------------------

    /// @notice Current status of a poll (None if the id does not exist).
    function status(uint256 pollId) public view returns (Status) {
        if (pollId == 0 || pollId > pollCount) return Status.None;
        Poll storage p = _polls[pollId];
        if (p.cancelled) return Status.Cancelled;
        // slither-disable-next-line timestamp
        if (block.timestamp < p.deadline) return Status.Open;
        return Status.Ended;
    }

    /// @notice The final result. Only available once the deadline has passed.
    /// @return outcome     NoVotes, Winner or Tie.
    /// @return winningOption Index of the winner (only meaningful when outcome == Winner).
    /// @return topVotes    The highest vote count.
    function getResult(uint256 pollId)
        external
        view
        pollExists(pollId)
        returns (Outcome outcome, uint256 winningOption, uint256 topVotes)
    {
        Status s = status(pollId);
        if (s != Status.Ended) revert ResultNotReady(pollId, s);

        Poll storage p = _polls[pollId];
        if (p.totalVotes == 0) return (Outcome.NoVotes, 0, 0);

        bool tie = false;
        uint256 n = p.votes.length; // at most MAX_OPTIONS, so this loop is always cheap
        for (uint256 i = 0; i < n; ++i) {
            uint256 v = p.votes[i];
            if (v > topVotes) {
                topVotes = v;
                winningOption = i;
                tie = false;
            } else if (v == topVotes) {
                tie = true;
            }
        }
        outcome = tie ? Outcome.Tie : Outcome.Winner;
    }

    /// @notice Everything about a poll in one call.
    function getPoll(uint256 pollId) external view pollExists(pollId) returns (PollView memory info) {
        Poll storage p = _polls[pollId];
        info.creator = p.creator;
        info.question = p.question;
        info.options = p.options;
        info.votes = p.votes;
        info.deadline = p.deadline;
        info.totalVotes = p.totalVotes;
        info.currentStatus = status(pollId);
    }

    /// @notice Has this address already voted in this poll?
    function hasVoted(uint256 pollId, address voter) external view returns (bool) {
        return _hasVoted[pollId][voter];
    }
}
