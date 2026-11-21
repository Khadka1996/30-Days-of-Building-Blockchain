// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TodoList — a personal to-do list on the blockchain
/// @author Manish Khadka
/// @notice Every address has its own list. Only that address can add, complete
///         or delete its tasks. Note: everything on a public blockchain can be
///         READ by anyone, so never store secrets in a task.
contract TodoList {
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

    /// @notice Add a task to YOUR list.
    /// @return id The new task's ID.
    function addTask(string calldata text) external returns (uint64 id) {
        uint256 length = bytes(text).length;
        if (length == 0) revert EmptyText();
        if (length > MAX_TEXT_LENGTH) revert TextTooLong(length, MAX_TEXT_LENGTH);

        Task[] storage list = _tasks[msg.sender];
        if (list.length >= MAX_TASKS) revert TooManyTasks(MAX_TASKS);

        id = ++_nextId[msg.sender]; // first id is 1, so 0 is never a valid id
        list.push(Task({id: id, createdAt: uint64(block.timestamp), completed: false, text: text}));
        _indexPlusOne[msg.sender][id] = list.length;

        emit TaskAdded(msg.sender, id, text);
    }

    /// @notice Mark one of YOUR tasks as done.
    function completeTask(uint64 id) external {
        Task storage task = _tasks[msg.sender][_indexOf(msg.sender, id)];
        if (task.completed) revert AlreadyCompleted(id);
        task.completed = true;
        emit TaskCompleted(msg.sender, id);
    }

    /// @notice Delete one of YOUR tasks. Other tasks keep their IDs.
    function deleteTask(uint64 id) external {
        Task[] storage list = _tasks[msg.sender];
        uint256 index = _indexOf(msg.sender, id);
        uint256 lastIndex = list.length - 1;

        // Swap-and-pop: move the last task into the gap, then shrink the array.
        if (index != lastIndex) {
            Task storage moved = list[lastIndex];
            list[index] = moved;
            _indexPlusOne[msg.sender][moved.id] = index + 1;
        }
        list.pop();
        delete _indexPlusOne[msg.sender][id];

        emit TaskDeleted(msg.sender, id);
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
