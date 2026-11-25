// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMessageReceiver} from "./Messenger.sol";

/// @title Day 26 — the Day 1 to-do list, reachable from another chain
/// @author Manish Khadka
/// @notice Deployed on both chains. Locally you call `addTask` (normal, like Day 1).
///         From the other chain you send a message through the Messenger, and
///         `onMessage` adds the task for you here.
/// @dev Bridge safety rules for a receiving app:
///  - only the local Messenger may call `onMessage` (nobody can fake a delivery);
///  - only messages from chains this app trusts (`trustedSource`) are accepted;
///  - tasks are stored per (chain, address): the same address on another chain is
///    NOT assumed to be the same person (a smart-contract wallet at address X on
///    L1 may belong to someone else on L2), so a remote sender can never write
///    into a local user's list.
contract CrossChainTodo is IMessageReceiver {
    struct Task {
        uint64 id;
        uint64 createdAt;
        uint256 fromChainId; // where the request was made
        string text;
    }

    uint256 public constant MAX_TEXT_LENGTH = 280;
    uint256 public constant MAX_TASKS = 100;

    address public immutable messenger;
    /// @notice The one remote chain this app accepts messages from.
    uint256 public immutable trustedSource;

    // keccak256(chainId, owner) => tasks
    mapping(bytes32 => Task[]) private _tasks;
    mapping(bytes32 => uint64) private _nextId;

    event TaskAdded(uint256 indexed chainId, address indexed owner, uint64 indexed id, string text);

    error EmptyText();
    error TextTooLong(uint256 length, uint256 max);
    error TooManyTasks(uint256 max);
    error NotMessenger();
    error UntrustedSource(uint256 chainId);
    error BadConfig();

    constructor(address messenger_, uint256 trustedSource_) {
        if (messenger_ == address(0) || trustedSource_ == block.chainid) revert BadConfig();
        messenger = messenger_;
        trustedSource = trustedSource_;
    }

    /// @notice Add a task to YOUR list on this chain.
    function addTask(string calldata text) external returns (uint64) {
        return _add(block.chainid, msg.sender, text);
    }

    /// @inheritdoc IMessageReceiver
    function onMessage(uint256 srcChainId, address sender, bytes calldata data) external {
        if (msg.sender != messenger) revert NotMessenger();
        if (srcChainId != trustedSource) revert UntrustedSource(srcChainId);
        _add(srcChainId, sender, abi.decode(data, (string)));
    }

    /// @notice Tasks of `owner` as known on chain `chainId`.
    function getTasks(uint256 chainId, address owner) external view returns (Task[] memory) {
        return _tasks[_key(chainId, owner)];
    }

    function _add(uint256 chainId, address owner, string memory text) private returns (uint64 id) {
        uint256 length = bytes(text).length;
        if (length == 0) revert EmptyText();
        if (length > MAX_TEXT_LENGTH) revert TextTooLong(length, MAX_TEXT_LENGTH);
        bytes32 k = _key(chainId, owner);
        if (_tasks[k].length >= MAX_TASKS) revert TooManyTasks(MAX_TASKS);
        id = ++_nextId[k];
        _tasks[k].push(Task({id: id, createdAt: uint64(block.timestamp), fromChainId: chainId, text: text}));
        emit TaskAdded(chainId, owner, id, text);
    }

    function _key(uint256 chainId, address owner) private pure returns (bytes32) {
        return keccak256(abi.encode(chainId, owner));
    }
}
