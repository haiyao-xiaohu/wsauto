// Paste into QuickNode Streams' JavaScript filter editor.
// Dataset: BNB Smart Chain Mainnet / Block with Receipts.
// Replace these fictional addresses with your own watchlist in the dashboard.
// Do not commit your real watchlist to a public repository.
// Schema: https://www.quicknode.com/docs/streams/data-sources/ethereum-evm
function main(stream) {
  const WATCH_WALLETS = [
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  const watched = new Set(WATCH_WALLETS.map(address => address.toLowerCase()));
  if (!watched.size || [...watched].some(address => !/^0x[0-9a-f]{40}$/.test(address))) {
    throw new Error("Configure valid WATCH_WALLETS addresses");
  }
  if (!Array.isArray(stream.data)) {
    throw new Error("Expected stream.data for the Block with Receipts dataset");
  }
  const matchingReceipts = [];
  for (const entry of stream.data) {
    if (!entry.block || !Array.isArray(entry.receipts)) {
      throw new Error("Select Block with Receipts; preview must contain block and receipts");
    }
    const timestamp = entry.block.timestamp;
    if (typeof timestamp !== "string" || !/^0x[0-9a-f]+$/i.test(timestamp)) {
      throw new Error("Expected a hexadecimal block.timestamp");
    }
    for (const receipt of entry.receipts) {
      if (receipt.status !== "0x1" || !watched.has(String(receipt.from).toLowerCase())) continue;
      matchingReceipts.push({
        blockNumber: receipt.blockNumber || entry.block.number,
        from: receipt.from,
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        logs: (receipt.logs || []).map(log => ({
          ...log,
          blockTimestamp: timestamp,
        })),
      });
    }
  }
  return matchingReceipts.length ? { matchingReceipts } : null;
}
