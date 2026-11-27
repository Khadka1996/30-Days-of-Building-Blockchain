// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title Pramaan (प्रमाण, "proof"): tamper-proof academic certificates for Nepal
/// @author Manish Khadka
/// @notice Boards and universities publish a fingerprint (hash) of every certificate they issue.
///         Anyone (an employer, a foreign-employment agency, an embassy, a university abroad) can
///         check a certificate in seconds, for free, without calling the institution.
///
///         No personal data goes on-chain: only `serial` (hash of the certificate number) and
///         `docHash` (hash of the certificate's fields plus a random salt printed in its QR code).
///
///         Roles
///         - Council (owner, meant to be a 2-of-3 multisig like Day 4): registers institutions,
///           suspends them and reports stolen keys. It can NOT issue or revoke certificates.
///         - Issuer (one key per institution): issues and revokes only its own certificates.
///
///         If an issuer's key is stolen, the council reports a compromise window: everything that key
///         did from `since` up to the report (issues AND revocations) is no longer trusted, the key is
///         replaced, and certificates issued before `since` stay valid.
contract Pramaan is Ownable2Step {
    enum Status {
        Unknown, // never issued, or the document was changed (hash does not match)
        Valid,
        Revoked, // withdrawn by the institution (reason code says why)
        Distrusted // issued with a key that was stolen at the time
    }

    struct Issuer {
        address key; // the institution's current signing key
        uint64 keyActiveFrom; // block from which `key` may act (a new key waits one block)
        bool active; // false = suspended: no new issues or revocations
        string name;
    }

    /// One certificate published on its own.
    struct Record {
        bytes32 docHash;
        uint64 time;
        uint64 blockNo;
    }

    /// Many certificates (e.g. a whole exam result) published as one Merkle root.
    struct Batch {
        bytes32 root;
        uint32 issuerId;
        uint32 count;
        uint64 time;
        uint64 blockNo;
    }

    struct Revocation {
        uint64 time;
        uint64 blockNo;
        uint8 reason; // 1 = fraud, 2 = error (re-issued with a new serial), 3 = withdrawn, ...
    }

    /// Actions with `time >= since` and `blockNo <= untilBlock` were made with a stolen key.
    struct Window {
        uint64 since;
        uint64 untilBlock;
    }

    uint256 public constant MAX_COMPROMISES = 5; // windows per issuer; keeps verify() cheap (more merge)
    uint256 public constant MAX_LOOKBACK = 180 days; // the council can't wipe out years of records

    uint32 public issuerCount;
    uint256 public batchCount;

    mapping(uint32 issuerId => Issuer) public issuers;
    mapping(address key => uint32 issuerId) public issuerOfKey;
    // Written in reportCompromise through a storage pointer (ws.push), which Slither does not follow.
    // slither-disable-next-line uninitialized-state
    mapping(uint32 issuerId => Window[]) internal _compromises;
    mapping(bytes32 certKey => Record) public records;
    mapping(uint256 batchId => Batch) public batches;
    mapping(bytes32 certKey => Revocation) public revocations;
    mapping(uint256 batchId => Revocation) public batchRevocations;
    mapping(address key => bool) public retiredKey; // a replaced key can never come back (F-4)

    event IssuerAdded(uint32 indexed issuerId, address indexed key, string name);
    event IssuerStatusChanged(uint32 indexed issuerId, bool active);
    event KeyRotated(uint32 indexed issuerId, address indexed oldKey, address indexed newKey);
    event CompromiseReported(uint32 indexed issuerId, uint64 since, uint64 untilBlock);
    event Issued(uint32 indexed issuerId, bytes32 indexed serial, bytes32 docHash);
    event BatchIssued(uint32 indexed issuerId, uint256 indexed batchId, bytes32 root, uint32 count);
    event Revoked(uint32 indexed issuerId, bytes32 indexed serial, uint8 reason);
    event BatchRevoked(uint32 indexed issuerId, uint256 indexed batchId, uint8 reason);

    error NotIssuer();
    error IssuerSuspended(uint32 issuerId);
    error KeyNotActiveYet(uint64 fromBlock);
    error ZeroValue();
    error KeyInUse(address key);
    error UnknownIssuer(uint32 issuerId);
    error AlreadyIssued(bytes32 serial);
    error AlreadyRevoked();
    error NotYourBatch(uint256 batchId);
    error UnknownBatch(uint256 batchId);
    error BadSince(uint64 since);
    error RenounceDisabled();

    constructor(address council) Ownable(council) {}

    /// @notice Disabled (F-3): without a council nobody could suspend an institution or report a stolen key.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ───────────────────────────── council ─────────────────────────────

    /// @notice Register an institution (e.g. "National Examinations Board") with its signing key.
    function addIssuer(address key, string calldata name) external onlyOwner returns (uint32 id) {
        if (bytes(name).length == 0) revert ZeroValue();
        _checkNewKey(key);
        id = ++issuerCount;
        issuers[id] = Issuer({key: key, keyActiveFrom: uint64(block.number), active: true, name: name});
        issuerOfKey[key] = id;
        emit IssuerAdded(id, key, name);
    }

    /// @notice Suspend (or reinstate) an institution. Certificates it already issued stay valid.
    function setIssuerActive(uint32 id, bool active) external onlyOwner {
        _existing(id).active = active;
        emit IssuerStatusChanged(id, active);
    }

    /// @notice Routine key change (new staff, new device). Nothing is distrusted.
    function rotateKey(uint32 id, address newKey) external onlyOwner {
        _rotate(id, newKey);
    }

    /// @notice A key was stolen: distrust everything it did from `since` until now and replace it.
    /// @param since when the theft may have started (at most MAX_LOOKBACK ago)
    function reportCompromise(uint32 id, uint64 since, address newKey) external onlyOwner {
        _existing(id);
        if (since > block.timestamp || since + MAX_LOOKBACK < block.timestamp) revert BadSince(since);
        Window[] storage ws = _compromises[id];
        if (ws.length < MAX_COMPROMISES) {
            ws.push(Window({since: since, untilBlock: uint64(block.number)}));
        } else {
            // F-2: never refuse a report. At the limit, stretch the last window to cover this one too.
            // It may distrust some real records in between; those can be re-issued (safe direction).
            Window storage last = ws[ws.length - 1];
            if (since < last.since) last.since = since;
            last.untilBlock = uint64(block.number);
        }
        emit CompromiseReported(id, since, uint64(block.number));
        _rotate(id, newKey);
    }

    // ───────────────────────────── issuers ─────────────────────────────

    /// @notice Publish one certificate. `serial` = keccak256(certificate number).
    function issue(bytes32 serial, bytes32 docHash) external {
        uint32 id = _callerIssuer();
        if (serial == bytes32(0) || docHash == bytes32(0)) revert ZeroValue();
        bytes32 key = certKey(id, serial);
        Record storage r = records[key];
        // A serial can be used once; the only exception is a record the stolen key made
        // (otherwise a thief could "squat" serials the real institution has not used yet).
        if (r.time != 0 && !_distrusted(id, r.time, r.blockNo)) revert AlreadyIssued(serial);
        records[key] = Record({docHash: docHash, time: uint64(block.timestamp), blockNo: uint64(block.number)});
        emit Issued(id, serial, docHash);
    }

    /// @notice Publish many certificates at once as a Merkle root (see lib/pramaan.js).
    function issueBatch(bytes32 root, uint32 count) external returns (uint256 batchId) {
        uint32 id = _callerIssuer();
        if (root == bytes32(0) || count == 0) revert ZeroValue();
        batchId = ++batchCount;
        batches[batchId] = Batch({
            root: root,
            issuerId: id,
            count: count,
            time: uint64(block.timestamp),
            blockNo: uint64(block.number)
        });
        emit BatchIssued(id, batchId, root, count);
    }

    /// @notice Withdraw one certificate (single or inside a batch) by its serial. Permanent.
    function revoke(bytes32 serial, uint8 reason) external {
        uint32 id = _callerIssuer();
        if (serial == bytes32(0) || reason == 0) revert ZeroValue();
        _revoke(id, revocations[certKey(id, serial)], reason);
        emit Revoked(id, serial, reason);
    }

    /// @notice Withdraw a whole batch (e.g. results published by mistake). Permanent.
    function revokeBatch(uint256 batchId, uint8 reason) external {
        uint32 id = _callerIssuer();
        Batch storage b = batches[batchId];
        if (b.root == bytes32(0)) revert UnknownBatch(batchId);
        if (b.issuerId != id) revert NotYourBatch(batchId);
        if (reason == 0) revert ZeroValue();
        _revoke(id, batchRevocations[batchId], reason);
        emit BatchRevoked(id, batchId, reason);
    }

    // ───────────────────────────── anyone ─────────────────────────────

    /// @notice Check a certificate that was published on its own.
    function verify(uint32 issuerId, bytes32 serial, bytes32 docHash)
        external
        view
        returns (Status status, uint64 issuedAt, uint8 reason)
    {
        Record storage r = records[certKey(issuerId, serial)];
        if (r.time == 0 || r.docHash != docHash) return (Status.Unknown, 0, 0);
        return _status(issuerId, serial, r.time, r.blockNo, 0);
    }

    /// @notice Check a certificate that was published inside a batch, with its Merkle proof.
    function verifyInBatch(uint256 batchId, bytes32 serial, bytes32 docHash, bytes32[] calldata proof)
        external
        view
        returns (Status status, uint64 issuedAt, uint8 reason)
    {
        Batch storage b = batches[batchId];
        if (b.root == bytes32(0)) return (Status.Unknown, 0, 0);
        // Double hash, like Day 10, so an inner node of the tree can never pass as a leaf.
        // The issuer id is inside the leaf, so another institution can't re-publish this root (F-1).
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(b.issuerId, serial, docHash))));
        if (!MerkleProof.verifyCalldata(proof, b.root, leaf)) return (Status.Unknown, 0, 0);
        return _status(b.issuerId, serial, b.time, b.blockNo, batchId);
    }

    function certKey(uint32 issuerId, bytes32 serial) public pure returns (bytes32) {
        return keccak256(abi.encode(issuerId, serial));
    }

    function compromises(uint32 issuerId) external view returns (Window[] memory) {
        return _compromises[issuerId];
    }

    // ───────────────────────────── internal ─────────────────────────────

    function _status(uint32 issuerId, bytes32 serial, uint64 time, uint64 blockNo, uint256 batchId)
        internal
        view
        returns (Status, uint64, uint8)
    {
        if (_distrusted(issuerId, time, blockNo)) return (Status.Distrusted, time, 0);
        if (batchId != 0) {
            Revocation storage br = batchRevocations[batchId];
            if (_trustedRevocation(issuerId, br)) return (Status.Revoked, time, br.reason);
        }
        Revocation storage rv = revocations[certKey(issuerId, serial)];
        if (_trustedRevocation(issuerId, rv)) return (Status.Revoked, time, rv.reason);
        return (Status.Valid, time, 0);
    }

    /// A revocation made with a stolen key is ignored, so a thief can't cancel real degrees.
    function _trustedRevocation(uint32 issuerId, Revocation storage rv) internal view returns (bool) {
        return rv.time != 0 && !_distrusted(issuerId, rv.time, rv.blockNo);
    }

    function _revoke(uint32 id, Revocation storage rv, uint8 reason) internal {
        if (_trustedRevocation(id, rv)) revert AlreadyRevoked();
        rv.time = uint64(block.timestamp);
        rv.blockNo = uint64(block.number);
        rv.reason = reason;
    }

    function _distrusted(uint32 issuerId, uint64 time, uint64 blockNo) internal view returns (bool) {
        Window[] storage ws = _compromises[issuerId];
        for (uint256 i = 0; i < ws.length; i++) {
            if (time >= ws[i].since && blockNo <= ws[i].untilBlock) return true;
        }
        return false;
    }

    function _callerIssuer() internal view returns (uint32 id) {
        id = issuerOfKey[msg.sender];
        if (id == 0) revert NotIssuer();
        Issuer storage s = issuers[id];
        if (!s.active) revert IssuerSuspended(id);
        if (block.number < s.keyActiveFrom) revert KeyNotActiveYet(s.keyActiveFrom);
    }

    function _rotate(uint32 id, address newKey) internal {
        Issuer storage s = _existing(id);
        _checkNewKey(newKey);
        address old = s.key;
        delete issuerOfKey[old];
        retiredKey[old] = true;
        s.key = newKey;
        // The new key starts next block, so nothing it does can fall inside a compromise window.
        s.keyActiveFrom = uint64(block.number + 1);
        issuerOfKey[newKey] = id;
        emit KeyRotated(id, old, newKey);
    }

    function _existing(uint32 id) internal view returns (Issuer storage s) {
        s = issuers[id];
        if (s.key == address(0)) revert UnknownIssuer(id);
    }

    function _checkNewKey(address key) internal view {
        if (key == address(0)) revert ZeroValue();
        if (issuerOfKey[key] != 0 || retiredKey[key] || key == owner()) revert KeyInUse(key);
    }
}
