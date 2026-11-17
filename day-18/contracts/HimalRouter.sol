// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HimalFactory} from "./HimalFactory.sol";
import {HimalPair} from "./HimalPair.sol";

/// @title HimalRouter — swap along a path of pools (A → B → C) and add or remove liquidity safely
/// @notice The router never holds tokens: they go from you straight into the first pool, from pool to
///         pool, and from the last pool straight to `to`. Every call that trades takes two guards:
///         - a **slippage limit** (`amountOutMin` / `amountInMax` / `amountAMin`…): the worst price you accept,
///         - a **deadline**: a timestamp after which the transaction refuses to run.
///         Together they stop sandwich attacks and transactions that sit in the queue until the price is bad.
/// @dev `bestPath` is a view for wallets and scripts to pick a route before sending a swap. It reads live
///      reserves, which one trade can move, so its answer must always be paired with `amountOutMin`.
contract HimalRouter {
    using SafeERC20 for IERC20;

    /// @notice Longest path allowed: 4 tokens, 3 hops.
    uint256 public constant MAX_PATH = 4;
    uint256 public constant MAX_CONNECTORS = 5;

    // solhint-disable-next-line immutable-vars-naming
    HimalFactory public immutable factory;
    /// @notice Middle tokens `bestPath` tries, like HUSD in HIM → HUSD → NPRT.
    address[] public connectors;

    error Expired(uint256 deadline, uint256 nowTime);
    error InvalidPath();
    error PairMissing(address tokenA, address tokenB);
    error InsufficientOutputAmount(uint256 received, uint256 minimum);
    error ExcessiveInputAmount(uint256 needed, uint256 maximum);
    error InsufficientAAmount(uint256 amountA, uint256 minimum);
    error InsufficientBAmount(uint256 amountB, uint256 minimum);
    error InsufficientLiquidity();
    error InsufficientAmount();
    error ZeroAddress();
    error TooManyConnectors();

    modifier ensure(uint256 deadline) {
        // solhint-disable-next-line gas-strict-inequalities
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        _;
    }

    constructor(HimalFactory factory_, address[] memory connectors_) {
        if (address(factory_) == address(0)) revert ZeroAddress();
        if (connectors_.length > MAX_CONNECTORS) revert TooManyConnectors();
        factory = factory_;
        for (uint256 i = 0; i < connectors_.length; i++) {
            if (connectors_[i] == address(0)) revert ZeroAddress();
            connectors.push(connectors_[i]);
        }
    }

    // ------------------------------------------------------------------ liquidity

    /// @notice Add both tokens at the pool's current ratio. Creates the pool if it does not exist.
    /// @param amountAMin, amountBMin the least of each token you accept to add: if someone moves the
    ///        price just before you, the deposit reverts instead of going in at a bad ratio.
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        if (to == address(0)) revert ZeroAddress();
        address pair = factory.getPair(tokenA, tokenB);
        if (pair == address(0)) pair = factory.createPair(tokenA, tokenB);

        (amountA, amountB) = _addAmounts(pair, tokenA, amountADesired, amountBDesired, amountAMin, amountBMin);
        liquidity = _deposit(pair, tokenA, tokenB, amountA, amountB, to);
    }

    /// @dev Moves both tokens from the caller straight into the pool and mints LP tokens to `to`.
    function _deposit(address pair, address tokenA, address tokenB, uint256 amountA, uint256 amountB, address to)
        private
        returns (uint256)
    {
        IERC20(tokenA).safeTransferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, pair, amountB);
        return HimalPair(pair).mint(to);
    }

    /// @notice Return LP tokens and get both tokens back, at least `amountAMin` and `amountBMin`.
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        if (to == address(0)) revert ZeroAddress();
        address pair = _pairFor(tokenA, tokenB);
        IERC20(pair).safeTransferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = HimalPair(pair).burn(to);
        (amountA, amountB) = tokenA < tokenB ? (amount0, amount1) : (amount1, amount0);
        if (amountA < amountAMin) revert InsufficientAAmount(amountA, amountAMin);
        if (amountB < amountBMin) revert InsufficientBAmount(amountB, amountBMin);
    }

    // ------------------------------------------------------------------ swaps

    /// @notice Sell exactly `amountIn` of path[0]; receive at least `amountOutMin` of the last token.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = getAmountsOut(amountIn, path);
        _pullAndSwap(amounts, path, to, amountOutMin);
    }

    /// @notice Buy exactly `amountOut` of the last token; pay at most `amountInMax` of path[0].
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = getAmountsIn(amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount(amounts[0], amountInMax);
        _pullAndSwap(amounts, path, to, amountOut);
    }

    /// @dev Sends amounts[0] into the first pool, runs every hop, then checks what really arrived at `to`.
    ///      Measuring the balance (not trusting the maths) also catches tokens that take a fee on transfer.
    function _pullAndSwap(uint256[] memory amounts, address[] calldata path, address to, uint256 minOut) private {
        if (to == address(0)) revert ZeroAddress();
        IERC20 tokenOut = IERC20(path[path.length - 1]);
        uint256 before = tokenOut.balanceOf(to);

        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        for (uint256 i = 0; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            uint256 out = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input < output ? (uint256(0), out) : (out, uint256(0));
            // Each pool pays the next pool directly; only the last one pays `to`.
            address recipient = i < path.length - 2 ? _pairFor(output, path[i + 2]) : to;
            HimalPair(_pairFor(input, output)).swap(amount0Out, amount1Out, recipient);
        }

        // Reviewed (slither reentrancy-balance): a re-entrant token could only ADD to `to`'s balance,
        // which helps the user, never the attacker. Pairs are nonReentrant. See QA.md.
        // slither-disable-next-line reentrancy-balance
        uint256 received = tokenOut.balanceOf(to) - before;
        // slither-disable-next-line reentrancy-balance
        if (received < minOut) revert InsufficientOutputAmount(received, minOut);
    }

    // ------------------------------------------------------------------ quotes and routing

    /// @notice Same value at the pool's current ratio, with no fee and no price impact.
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) public pure returns (uint256) {
        if (amountA == 0) revert InsufficientAmount();
        if (reserveA == 0 || reserveB == 0) revert InsufficientLiquidity();
        return (amountA * reserveB) / reserveA;
    }

    /// @notice Output for `amountIn` in one pool, after the 0.3% fee. Rounds down (in the pool's favour).
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert InsufficientAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * reserveOut) / (reserveIn * 1000 + inWithFee);
    }

    /// @notice Input needed to get exactly `amountOut` from one pool. Rounds up (+1), in the pool's favour.
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountOut == 0) revert InsufficientAmount();
        if (reserveIn == 0 || amountOut >= reserveOut) revert InsufficientLiquidity();
        return (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) public view returns (uint256[] memory amounts) {
        _checkPath(path);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            (uint256 rIn, uint256 rOut) = _reserves(_pairFor(path[i], path[i + 1]), path[i]);
            amounts[i + 1] = getAmountOut(amounts[i], rIn, rOut);
        }
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path) public view returns (uint256[] memory amounts) {
        _checkPath(path);
        amounts = new uint256[](path.length);
        amounts[path.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 rIn, uint256 rOut) = _reserves(_pairFor(path[i - 1], path[i]), path[i - 1]);
            amounts[i - 1] = getAmountIn(amounts[i], rIn, rOut);
        }
    }

    /// @notice Find the route that gives the most `tokenOut` for `amountIn`: the direct pool, or
    ///         through one connector token (A → connector → C). Returns an empty path if none exists.
    /// @dev For off-chain use (wallets, scripts). Always swap with an `amountOutMin` below the quote.
    function bestPath(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (address[] memory path, uint256 amountOut)
    {
        if (tokenIn == tokenOut || amountIn == 0) revert InvalidPath();
        uint256 direct = _tryHop(tokenIn, tokenOut, amountIn);
        if (direct > 0) {
            path = new address[](2);
            (path[0], path[1]) = (tokenIn, tokenOut);
            amountOut = direct;
        }
        uint256 n = connectors.length;
        for (uint256 i = 0; i < n; i++) {
            address mid = connectors[i];
            if (mid == tokenIn || mid == tokenOut) continue;
            uint256 viaMid = _tryHop(mid, tokenOut, _tryHop(tokenIn, mid, amountIn));
            if (viaMid > amountOut) {
                path = new address[](3);
                (path[0], path[1], path[2]) = (tokenIn, mid, tokenOut);
                amountOut = viaMid;
            }
        }
    }

    function connectorsLength() external view returns (uint256) {
        return connectors.length;
    }

    // ------------------------------------------------------------------ helpers

    /// @dev One hop's output, or 0 if the pool is missing, empty or too small (never reverts).
    function _tryHop(address tokenIn, address tokenOut, uint256 amountIn) private view returns (uint256) {
        if (amountIn == 0) return 0;
        address pair = factory.getPair(tokenIn, tokenOut);
        if (pair == address(0)) return 0;
        (uint256 rIn, uint256 rOut) = _reserves(pair, tokenIn);
        if (rIn == 0 || rOut == 0) return 0;
        return getAmountOut(amountIn, rIn, rOut);
    }

    /// @dev The amounts to add at the pool's current ratio, checked against the minimums.
    function _addAmounts(
        address pair,
        address tokenA,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) private view returns (uint256 amountA, uint256 amountB) {
        (uint256 rA, uint256 rB) = _reserves(pair, tokenA);
        if (rA == 0 && rB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 bOptimal = quote(amountADesired, rA, rB);
            if (bOptimal <= amountBDesired) {
                if (bOptimal < amountBMin) revert InsufficientBAmount(bOptimal, amountBMin);
                (amountA, amountB) = (amountADesired, bOptimal);
            } else {
                uint256 aOptimal = quote(amountBDesired, rB, rA);
                // aOptimal <= amountADesired always holds here, because bOptimal > amountBDesired.
                if (aOptimal < amountAMin) revert InsufficientAAmount(aOptimal, amountAMin);
                (amountA, amountB) = (aOptimal, amountBDesired);
            }
        }
    }

    function _checkPath(address[] calldata path) private pure {
        if (path.length < 2 || path.length > MAX_PATH) revert InvalidPath();
    }

    function _pairFor(address tokenA, address tokenB) private view returns (address pair) {
        pair = factory.getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairMissing(tokenA, tokenB);
    }

    /// @dev Reserves of `pair` ordered as (reserve of tokenA, reserve of the other token).
    function _reserves(address pair, address tokenA) private view returns (uint256 rA, uint256 rB) {
        (uint256 r0, uint256 r1) = HimalPair(pair).getReserves();
        (rA, rB) = tokenA == address(HimalPair(pair).token0()) ? (r0, r1) : (r1, r0);
    }
}
