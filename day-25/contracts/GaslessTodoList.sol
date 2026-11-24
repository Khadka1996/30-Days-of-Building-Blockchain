// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/// @title GaslessTodoList — the Day 1 to-do list, now usable without ETH
/// @author Manish Khadka
/// @notice Same rules as Day 1: every address has its own list and only that
///         address can change it. New: a call can also arrive through ONE trusted
///         Forwarder (ERC-2771), which passes along the real user, so a relayer
///         can pay the gas. Everything on a public chain can be READ by anyone.
/// @dev    The only change from Day 1 is `msg.sender` -> `_msgSender()`.
///         `_msgSender()` reads the appended user address ONLY when the caller is
///         the trusted forwarder; for everyone else it is plain `msg.sender`, so
///         nobody can fake a sender by adding 20 bytes to a direct call.
///         Do NOT add Multicall to an ERC-2771 contract: batching through the
///         forwarder breaks the "last 20 bytes" rule and lets users spoof others
///         (OpenZeppelin advisory, December 2023).
contract GaslessTodoList is ERC2771Context {
    /// @notice One task in a list.
    struct Task {
        uint64 id;          // stable ID: never changes, never reused
        uint64 createdAt;   // block timestamp when the task was added
        bool completed;     // true once the owner marks it done
        string text;        // what needs doing
    }

    /// @notice Longest task text allowed, in bytes (keeps storage costs sane).
    uint256 public constant MAX_TEXT_LENGTH = 280;
    /// @notice Most open tasks one address can hold (keeps reads bounded).
    uint256 public constant MAX_TASKS = 100;

    // owner => their tasks (order can change when a task is deleted)
    mapping(address => Task[]) private _tasks;
    // owner => task id => (index in _tasks + 1); 0 means "no such task"
    mapping(address => mapping(uint64 => uint256)) private _indexPlusOne;
    // owner => next id to hand out (starts at 1)
    mapping(address => uint64) private _nextId;

    event TaskAdded(address indexed owner, uint64 indexed id, string text);
    event TaskCompleted(address indexed owner, uint64 indexed id);
    event TaskDeleted(address indexed owner, uint64 indexed id);

    error EmptyText();
    error TextTooLong(uint256 length, uint256 max);
    error TooManyTasks(uint256 max);
    error TaskNotFound(uint64 id);
    error AlreadyCompleted(uint64 id);
    error ZeroForwarder();

    /// @param forwarder The ONE forwarder this contract trusts. Fixed forever.
    constructor(address forwarder) ERC2771Context(forwarder) {
        if (forwarder == address(0)) revert ZeroForwarder();
    }

    /// @notice Add a task to YOUR list.
    /// @return id The new task's ID.
    function addTask(string calldata text) external returns (uint64 id) {
        uint256 length = bytes(text).length;
        if (length == 0) revert EmptyText();
        if (length > MAX_TEXT_LENGTH) revert TextTooLong(length, MAX_TEXT_LENGTH);

        address user = _msgSender();
        Task[] storage list = _tasks[user];
        if (list.length >= MAX_TASKS) revert TooManyTasks(MAX_TASKS);

        id = ++_nextId[user]; // first id is 1, so 0 is never a valid id
        list.push(Task({id: id, createdAt: uint64(block.timestamp), completed: false, text: text}));
        _indexPlusOne[user][id] = list.length;

        emit TaskAdded(user, id, text);
    }

    /// @notice Mark one of YOUR tasks as done.
    function completeTask(uint64 id) external {
        address user = _msgSender();
        Task storage task = _tasks[user][_indexOf(user, id)];
        if (task.completed) revert AlreadyCompleted(id);
        task.completed = true;
        emit TaskCompleted(user, id);
    }

    /// @notice Delete one of YOUR tasks. Other tasks keep their IDs.
    function deleteTask(uint64 id) external {
        address user = _msgSender();
        Task[] storage list = _tasks[user];
        uint256 index = _indexOf(user, id);
        uint256 lastIndex = list.length - 1;

        // Swap-and-pop: move the last task into the gap, then shrink the array.
        if (index != lastIndex) {
            Task storage moved = list[lastIndex];
            list[index] = moved;
            _indexPlusOne[user][moved.id] = index + 1;
        }
        list.pop();
        delete _indexPlusOne[user][id];

        emit TaskDeleted(user, id);
    }

    /// @notice Read every task in someone's list (the order may change after deletes).
    function getTasks(address owner) external view returns (Task[] memory) {
        return _tasks[owner];
    }

    /// @notice Read one task by its ID.
    function getTask(address owner, uint64 id) external view returns (Task memory) {
        return _tasks[owner][_indexOf(owner, id)];
    }

    /// @notice How many tasks someone has right now.
    function taskCount(address owner) external view returns (uint256) {
        return _tasks[owner].length;
    }

    /// @dev Find a task's array index or revert. Always scoped to one owner,
    ///      so nobody can reach into another person's list.
    function _indexOf(address owner, uint64 id) private view returns (uint256) {
        uint256 indexPlusOne = _indexPlusOne[owner][id];
        if (indexPlusOne == 0) revert TaskNotFound(id);
        return indexPlusOne - 1;
    }
}
