// Builds the allowlist Merkle tree from a list of wallet addresses. Uses ethers only (same method as Day 10).
// The list is checked first: a mistake here would be locked into the root for ever.
const { AbiCoder, concat, getAddress, keccak256, ZeroAddress } = require("ethers");

const coder = AbiCoder.defaultAbiCoder();

// The same double hash as the contract, so an inner node can never pass as a leaf.
function hashLeaf(address) {
  return keccak256(keccak256(coder.encode(["address"], [address])));
}

// Sort the pair before hashing, like OpenZeppelin's MerkleProof, so a proof needs no left/right flags.
function hashPair(a, b) {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

// levels[0] holds the sorted leaves, the last level holds only the root. An odd node moves up unchanged.
function buildLevels(leaves) {
  const levels = [[...leaves].sort()];
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1];
    const above = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(i + 1 < below.length ? hashPair(below[i], below[i + 1]) : below[i]);
    }
    levels.push(above);
  }
  return levels;
}

function buildAllowlist(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("the allowlist is empty");
  const seen = new Set();
  const wallets = addresses.map((raw, i) => {
    const address = getAddress(raw); // throws on a malformed address or a wrong checksum
    if (address === ZeroAddress) throw new Error(`entry ${i}: zero address`);
    if (seen.has(address)) throw new Error(`entry ${i}: duplicate address ${address}`);
    seen.add(address);
    return address;
  });

  const levels = buildLevels(wallets.map(hashLeaf));
  const root = levels[levels.length - 1][0];

  function proofFor(address) {
    const leaf = hashLeaf(getAddress(address));
    let position = levels[0].indexOf(leaf);
    if (position === -1) return []; // not on the list: an empty proof, which the contract rejects
    const proof = [];
    for (let depth = 0; depth < levels.length - 1; depth++) {
      const sibling = position % 2 === 0 ? position + 1 : position - 1;
      if (sibling < levels[depth].length) proof.push(levels[depth][sibling]);
      position = Math.floor(position / 2);
    }
    return proof;
  }

  return { root, wallets, proofFor };
}

module.exports = { buildAllowlist, hashLeaf };
