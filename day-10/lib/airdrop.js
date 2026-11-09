// Builds the Merkle tree from a list of { address, amount } entries. Uses ethers only.
// The list is checked first: a mistake here would be locked into the root for ever.
const { AbiCoder, concat, getAddress, keccak256, ZeroAddress } = require("ethers");

const coder = AbiCoder.defaultAbiCoder();

// The same double hash as the contract, so an inner node can never pass as a leaf.
function hashLeaf(index, address, amount) {
  return keccak256(keccak256(coder.encode(["uint256", "address", "uint256"], [index, address, amount])));
}

// Sort the pair before hashing, like OpenZeppelin's MerkleProof, so a proof needs no left/right flags.
function hashPair(a, b) {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

// levels[0] holds the leaves, the last level holds only the root. An odd node moves up unchanged.
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

function proofForLeaf(levels, leaf) {
  const proof = [];
  let position = levels[0].indexOf(leaf);
  for (let depth = 0; depth < levels.length - 1; depth++) {
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    if (sibling < levels[depth].length) proof.push(levels[depth][sibling]);
    position = Math.floor(position / 2);
  }
  return proof;
}

function buildAirdrop(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("the list is empty");

  const seen = new Set();
  let total = 0n;
  const values = list.map((entry, index) => {
    // getAddress throws on a malformed address or a wrong checksum.
    const address = getAddress(entry.address);
    if (address === ZeroAddress) throw new Error(`entry ${index}: zero address`);
    if (seen.has(address)) throw new Error(`entry ${index}: duplicate address ${address}`);
    seen.add(address);

    const amount = BigInt(entry.amount);
    if (amount <= 0n) throw new Error(`entry ${index}: amount must be above zero`);
    total += amount;
    return [index.toString(), address, amount.toString()];
  });

  const leaves = values.map(([index, address, amount]) => hashLeaf(index, address, amount));
  const levels = buildLevels(leaves);
  const root = levels[levels.length - 1][0];
  const proofFor = (index) => proofForLeaf(levels, leaves[index]);

  return { root, total, values, proofFor };
}

module.exports = { buildAirdrop };
