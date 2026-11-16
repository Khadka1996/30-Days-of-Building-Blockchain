// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title HimalPair — one constant-product swap pool (x × y = k) for two tokens
/// @notice A teaching version of a Uniswap V2 pair. It holds two tokens and keeps
///         reserve0 × reserve1 from going down on any swap, after a 0.3% fee.
///         Liquidity providers get "Himal LP" tokens: their share of the pool.
/// @dev Low-level, like Uniswap V2: callers send tokens in first, then call `mint`, `burn` or `swap`,
///      and the pair works out what arrived from its balance. People normally use `HimalRouter`,
///      which does both steps in one transaction and checks slippage and deadlines.
contract HimalPair is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice LP tokens burned forever by the first deposit, so the share price can never be pushed
    ///         to a level where small deposits round down to zero shares.
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    /// @dev The first MINIMUM_LIQUIDITY shares go here. OpenZeppelin v5 refuses to mint to address(0).
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice Swap fee: 3 parts in 1000 (0.3%), left in the pool for liquidity providers.
    uint256 public constant FEE_PER_THOUSAND = 3;
    /// @notice Largest reserve allowed (2^112 − 1, as in Uniswap V2). Keeps the k check
    ///         (balance × 1000)² far below 2^256, so it can never overflow and lock the pool.
    uint256 public constant MAX_RESERVE = type(uint112).max;

    // solhint-disable immutable-vars-naming
    address public immutable factory;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    // solhint-enable immutable-vars-naming

    uint256 private reserve0;
    uint256 private reserve1;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint256 reserve0, uint256 reserve1);

    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientInputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error KInvariant();
    error Overflow();

    /// @dev Deployed only by HimalFactory, which sorts the tokens so token0 < token1.
    constructor(IERC20 token0_, IERC20 token1_) ERC20("Himal Swap LP", "HLP") {
        factory = msg.sender;
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice The amounts the pool last recorded. Prices come from these, never from raw balances,
    ///         so sending tokens straight to the pair does not change any price until `sync`.
    function getReserves() public view returns (uint256, uint256) {
        return (reserve0, reserve1);
    }

    /// @notice Add liquidity: call after sending both tokens in. Mints LP tokens to `to`.
    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));
        uint256 amount0 = bal0 - r0;
        uint256 amount1 = bal1 - r1;

        uint256 supply = totalSupply();
        // slither-disable-next-line incorrect-equality
        if (supply == 0) {
            // First deposit: shares = √(amount0 × amount1), and 1000 of them are locked forever.
            liquidity = Math.sqrt(amount0 * amount1);
            if (liquidity <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            liquidity -= MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
        } else {
            // Later deposits: the smaller of the two ratios, so adding at the wrong ratio only hurts the adder.
            liquidity = Math.min((amount0 * supply) / r0, (amount1 * supply) / r1);
        }
        // slither-disable-next-line incorrect-equality
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(bal0, bal1);
        emit Mint(msg.sender, amount0, amount1, to);
    }

    /// @notice Remove liquidity: call after sending LP tokens to the pair. Sends both tokens to `to`.
    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));
        uint256 supply = totalSupply();

        // Rounds down: the leaver never gets more than their share.
        amount0 = (liquidity * bal0) / supply;
        amount1 = (liquidity * bal1) / supply;
        // slither-disable-next-line incorrect-equality
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();

        _burn(address(this), liquidity);
        token0.safeTransfer(to, amount0);
        token1.safeTransfer(to, amount1);

        _update(token0.balanceOf(address(this)), token1.balanceOf(address(this)));
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Swap: send the input token in first, then ask for `amount0Out` / `amount1Out`.
    /// @dev The pair pays out, then checks that (balance after the 0.3% fee) still keeps k from falling.
    ///      There is no callback here; borrowing before paying (flash swaps) is Day 18.
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external nonReentrant {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        if (amount0Out >= r0 || amount1Out >= r1) revert InsufficientLiquidity();
        if (to == address(token0) || to == address(token1) || to == address(this)) revert InvalidTo();

        if (amount0Out > 0) token0.safeTransfer(to, amount0Out);
        if (amount1Out > 0) token1.safeTransfer(to, amount1Out);

        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));
        uint256 amount0In = bal0 > r0 - amount0Out ? bal0 - (r0 - amount0Out) : 0;
        uint256 amount1In = bal1 > r1 - amount1Out ? bal1 - (r1 - amount1Out) : 0;
        // slither-disable-next-line incorrect-equality
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();

        // k check with the fee taken out of the input: (bal × 1000 − in × 3) on each side.
        uint256 adj0 = bal0 * 1000 - amount0In * FEE_PER_THOUSAND;
        uint256 adj1 = bal1 * 1000 - amount1In * FEE_PER_THOUSAND;
        if (adj0 * adj1 < r0 * r1 * 1_000_000) revert KInvariant();

        _update(bal0, bal1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @notice Send any tokens above the reserves (for example a mistaken transfer) to `to`.
    function skim(address to) external nonReentrant {
        token0.safeTransfer(to, token0.balanceOf(address(this)) - reserve0);
        token1.safeTransfer(to, token1.balanceOf(address(this)) - reserve1);
    }

    /// @notice Make the reserves equal the real balances (gifts become part of the pool).
    function sync() external nonReentrant {
        _update(token0.balanceOf(address(this)), token1.balanceOf(address(this)));
    }

    function _update(uint256 bal0, uint256 bal1) private {
        if (bal0 > MAX_RESERVE || bal1 > MAX_RESERVE) revert Overflow();
        reserve0 = bal0;
        reserve1 = bal1;
        emit Sync(bal0, bal1);
    }
}
