// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title EverestDollar (EUSD) — a dollar-pegged stablecoin
/// @author Manish Khadka
/// @notice 1 EUSD aims to be worth 1 US dollar. Nobody "has" a supply of it: every EUSD is minted
///         by the DollarEngine against locked ETH, and burned again when the debt is repaid.
/// @dev    The engine creates this token in its own constructor, so the engine is the only minter,
///         forever. There is no owner and no way to add another minter.
contract EverestDollar is ERC20 {
    /// @notice The only address allowed to mint and burn: the DollarEngine that deployed this token.
    // solhint-disable-next-line immutable-vars-naming
    address public immutable engine;

    error OnlyEngine(address caller);

    constructor() ERC20("Everest Dollar", "EUSD") {
        engine = msg.sender;
    }

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine(msg.sender);
        _;
    }

    /// @notice Create new EUSD for a vault owner who just took on the same amount of debt.
    function mint(address to, uint256 amount) external onlyEngine {
        _mint(to, amount);
    }

    /// @notice Destroy EUSD when debt is repaid. The engine only ever burns from the caller of
    ///         repay() or liquidate(), never from a third party.
    function burn(address from, uint256 amount) external onlyEngine {
        _burn(from, amount);
    }
}
