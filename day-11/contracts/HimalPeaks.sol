// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Public immutables keep readable getter names (maxSupply(), treasury(), ...) for the front end and tests.
// solhint-disable immutable-vars-naming

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title HimalPeaks — an NFT collection with an allowlist sale, a public sale and a hard max supply
/// @author Manish Khadka
/// @notice The sale runs in phases chosen by the owner: Closed → Allowlist → Public → Closed.
///         - Allowlist: only wallets in the Merkle root may mint, at a lower price, up to
///           `ALLOWLIST_LIMIT` each.
///         - Public: anyone may mint, up to `PUBLIC_LIMIT` per wallet.
///         - The owner may mint up to `teamReserve` for the team at any time, never more.
///         No phase, and no combination of phases, can ever create more than `maxSupply` tokens.
/// @dev Limits are counted per wallet and saved BEFORE any token is minted, and every mint path
///      is `nonReentrant`, so a wallet contract that calls back from `onERC721Received` cannot
///      mint past its limit or past the supply. Payment must be exact, so nobody overpays by mistake.
contract HimalPeaks is ERC721, Ownable, ReentrancyGuard {
    using Strings for uint256;

    enum Phase {
        Closed,
        Allowlist,
        Public
    }

    /// @notice Most tokens one wallet can mint in the allowlist phase.
    uint256 public constant ALLOWLIST_LIMIT = 2;
    /// @notice Most tokens one wallet can mint in the public phase.
    uint256 public constant PUBLIC_LIMIT = 3;

    uint256 public immutable maxSupply;
    uint256 public immutable teamReserve;
    uint256 public immutable allowlistPrice;
    uint256 public immutable publicPrice;
    /// @notice The only address sale money can be sent to.
    address public immutable treasury;
    /// @notice Root of the allowlist Merkle tree. Leaves are double-hashed wallet addresses.
    bytes32 public immutable allowlistRoot;

    Phase public phase;
    /// @notice Tokens minted so far. Token ids run from 1 to `maxSupply`.
    uint256 public totalMinted;
    uint256 public teamMinted;
    mapping(address wallet => uint256 count) public allowlistMinted;
    mapping(address wallet => uint256 count) public publicMinted;

    string private _baseTokenURI;
    bool public metadataFrozen;

    event PhaseChanged(Phase phase);
    event Minted(address indexed to, uint256 firstId, uint256 quantity, uint256 paid);
    event TeamMinted(address indexed to, uint256 quantity, uint256 teamMintedTotal);
    event BaseURIChanged(string baseURI);
    event MetadataFrozen();
    event Withdrawn(address indexed treasury, uint256 amount);

    error WrongPhase(Phase current);
    error ZeroQuantity();
    error SoldOut(uint256 requested, uint256 remaining);
    error WalletLimit(uint256 requested, uint256 left);
    error ReserveExceeded(uint256 requested, uint256 left);
    error WrongPayment(uint256 sent, uint256 required);
    error NotOnAllowlist();
    error InvalidConfig();
    error MetadataIsFrozen();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(
        address initialOwner,
        address treasury_,
        uint256 maxSupply_,
        uint256 teamReserve_,
        uint256 allowlistPrice_,
        uint256 publicPrice_,
        bytes32 allowlistRoot_,
        string memory baseURI_
    ) ERC721("Himal Peaks", "PEAK") Ownable(initialOwner) {
        if (
            treasury_ == address(0) || maxSupply_ == 0 || teamReserve_ > maxSupply_ || publicPrice_ == 0
                || allowlistPrice_ == 0 || allowlistPrice_ > publicPrice_ || allowlistRoot_ == bytes32(0)
        ) revert InvalidConfig();
        treasury = treasury_;
        maxSupply = maxSupply_;
        teamReserve = teamReserve_;
        allowlistPrice = allowlistPrice_;
        publicPrice = publicPrice_;
        allowlistRoot = allowlistRoot_;
        _baseTokenURI = baseURI_;
    }

    // ---------------------------------------------------------------- minting

    /// @notice Mint in the allowlist phase. `proof` shows that your own wallet is on the list.
    function allowlistMint(uint256 quantity, bytes32[] calldata proof) external payable nonReentrant {
        if (phase != Phase.Allowlist) revert WrongPhase(phase);
        // The leaf is built from msg.sender, so a proof copied from the mempool is useless to anyone else.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
        if (!MerkleProof.verifyCalldata(proof, allowlistRoot, leaf)) revert NotOnAllowlist();

        uint256 used = allowlistMinted[msg.sender];
        if (used + quantity > ALLOWLIST_LIMIT) revert WalletLimit(quantity, ALLOWLIST_LIMIT - used);
        allowlistMinted[msg.sender] = used + quantity;

        _sell(quantity, allowlistPrice);
    }

    /// @notice Mint in the public phase.
    function publicMint(uint256 quantity) external payable nonReentrant {
        if (phase != Phase.Public) revert WrongPhase(phase);

        uint256 used = publicMinted[msg.sender];
        if (used + quantity > PUBLIC_LIMIT) revert WalletLimit(quantity, PUBLIC_LIMIT - used);
        publicMinted[msg.sender] = used + quantity;

        _sell(quantity, publicPrice);
    }

    /// @notice Free mint for the team, capped at `teamReserve` for ever. Works in any phase.
    function teamMint(address to, uint256 quantity) external onlyOwner nonReentrant {
        uint256 left = teamReserve - teamMinted;
        if (quantity > left) revert ReserveExceeded(quantity, left);
        teamMinted += quantity;
        emit TeamMinted(to, quantity, teamMinted);
        _mintBatch(to, quantity, 0);
    }

    /// @notice How many tokens can still be sold to the public, keeping the unminted team reserve aside.
    function saleRemaining() public view returns (uint256) {
        return maxSupply - totalMinted - (teamReserve - teamMinted);
    }

    /// @dev Shared by both sale phases: exact payment, then supply check, then mint.
    function _sell(uint256 quantity, uint256 price) private {
        if (msg.value != price * quantity) revert WrongPayment(msg.value, price * quantity);
        uint256 remaining = saleRemaining();
        if (quantity > remaining) revert SoldOut(quantity, remaining);
        _mintBatch(msg.sender, quantity, msg.value);
    }

    /// @dev Every mint goes through here. The supply is checked and the counter is moved
    ///      before the first `_safeMint`, which may call into the receiver.
    function _mintBatch(address to, uint256 quantity, uint256 paid) private {
        if (quantity == 0) revert ZeroQuantity();
        uint256 first = totalMinted + 1;
        if (totalMinted + quantity > maxSupply) revert SoldOut(quantity, maxSupply - totalMinted);
        totalMinted += quantity;
        emit Minted(to, first, quantity, paid);
        for (uint256 i = 0; i < quantity; ++i) {
            _safeMint(to, first + i);
        }
    }

    // ---------------------------------------------------------------- owner

    function setPhase(Phase newPhase) external onlyOwner {
        phase = newPhase;
        emit PhaseChanged(newPhase);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        _baseTokenURI = baseURI_;
        emit BaseURIChanged(baseURI_);
    }

    /// @notice Locks the metadata link for ever, so collectors know the art cannot be swapped.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// @notice Sends all sale money to the fixed treasury. Only the owner can trigger it,
    ///         and the money can only ever go to `treasury`.
    function withdraw() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        // Exact check is intended: there is simply nothing to send.
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert NothingToWithdraw();
        emit Withdrawn(treasury, amount);
        // A plain call (not transfer) so a multisig treasury with a receive() costing over 2300 gas still works.
        // slither-disable-next-line low-level-calls
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------- metadata

    /// @notice `<baseURI><id>.json`, for example `ipfs://<cid>/7.json`.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_baseTokenURI, tokenId.toString(), ".json");
    }
}
