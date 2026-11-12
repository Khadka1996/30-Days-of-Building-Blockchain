// SPDX-License-Identifier: MIT
// Test-only attacker helpers: several small contracts and low-level calls on purpose.
// solhint-disable one-contract-per-file, no-complex-fallback, avoid-low-level-calls
pragma solidity 0.8.24;

interface IEnglish {
    function bid() external payable;
    function withdraw() external;
}

interface IDutch {
    function buy() external payable;
}

/// @notice Test-only: a bidder whose wallet refuses ETH and refuses NFTs sent with
///         safeTransferFrom. Used to prove it cannot block other bidders or the end.
contract RejectingBidder {
    function bid(address auction) external payable {
        IEnglish(auction).bid{value: msg.value}();
    }

    function withdrawFrom(address auction) external {
        IEnglish(auction).withdraw();
    }

    function buyFrom(address auction) external payable {
        IDutch(auction).buy{value: msg.value}();
    }

    receive() external payable {
        revert("no ETH please");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("no NFTs please");
    }
}

/// @notice Test-only: tries to call withdraw (or buy) again while it is being paid.
contract ReentrantBidder {
    address public target;
    bool public dutch;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;

    function bid(address auction) external payable {
        target = auction;
        IEnglish(auction).bid{value: msg.value}();
    }

    function withdrawFrom(address auction) external {
        target = auction;
        IEnglish(auction).withdraw();
    }

    function buyFrom(address auction) external payable {
        target = auction;
        dutch = true;
        IDutch(auction).buy{value: msg.value}();
    }

    receive() external payable {
        if (reentryAttempts > 0) return;
        reentryAttempts++;
        if (dutch) {
            (reentrySucceeded, ) = target.call{value: 0}(abi.encodeWithSignature("buy()"));
        } else {
            (reentrySucceeded, ) = target.call(abi.encodeWithSignature("withdraw()"));
        }
    }
}

/// @notice Test-only: the naive "push refund" auction that the real one replaces. Each new
///         bid pays the previous leader back immediately. Used to show the refund DoS.
contract PushRefundAuction {
    address public highestBidder;
    uint256 public highestBid;

    function bid() external payable {
        require(msg.value > highestBid, "bid too low");
        if (highestBidder != address(0)) {
            (bool ok, ) = payable(highestBidder).call{value: highestBid}("");
            require(ok, "refund failed");
        }
        highestBidder = msg.sender;
        highestBid = msg.value;
    }
}
