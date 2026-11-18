// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IEngine {
    function deposit() external payable;
    function mint(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function liquidate(address user, uint256 amount) external returns (uint256);
}

/// @title ReentrantVault — TEST ONLY. A vault owner (or liquidator) contract that misbehaves when it
///        receives ETH: it tries to call back into the engine, or it refuses the ETH.
contract ReentrantVault {
    enum Mode {
        Nice,
        WithdrawAgain,
        MintAgain,
        Reject
    }

    // solhint-disable-next-line immutable-vars-naming
    IEngine public immutable engine;
    Mode public mode;
    bool public reentered; // set if a call back into the engine ever succeeded

    constructor(IEngine engine_) {
        engine = engine_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function deposit() external payable {
        engine.deposit{value: msg.value}();
    }

    function mint(uint256 amount) external {
        engine.mint(amount);
    }

    function withdraw(uint256 amount) external {
        engine.withdraw(amount);
    }

    function liquidate(address user, uint256 amount) external {
        engine.liquidate(user, amount);
    }

    // Complex on purpose: it is the misbehaving receiver.
    // solhint-disable-next-line no-complex-fallback
    receive() external payable {
        if (mode == Mode.Reject) revert("no ETH please");
        if (mode == Mode.WithdrawAgain) {
            engine.withdraw(msg.value);
            reentered = true;
        } else if (mode == Mode.MintAgain) {
            engine.mint(100e18);
            reentered = true;
        }
    }
}
