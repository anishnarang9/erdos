// Arc testnet helpers for the static site: JSON-RPC (via /rpc with a public fallback), hand-rolled ABI encoding
// for the few escrow calls the marketplace makes, the explorer's decoded event log, and an EIP-1193 wallet.
export const CHAIN_ID = 5042002;
export const EXPLORER = 'https://explorer.testnet.arc.io';
export const CORE = '0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8';
export const ADAPTER = '0x1fed5e532a1405facd45b4096ad1abf25bba0cb8';
export const USDC = '0x3600000000000000000000000000000000000000';
export const ZERO = '0x0000000000000000000000000000000000000000';
const JOB_CREATED = '0xb0f0239bfdd96453e24733e18bfc24b70d8fadf123dd977473518dd577ee79b9';
let RPCS = ['/rpc', 'https://rpc.testnet.arc.io'];
const dropRelay = () => { if (RPCS.length > 1) RPCS = RPCS.slice(1); }; // the local preview has no /rpc relay

export async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) { if (url === '/rpc' && res.status >= 400 && res.status < 500 || res.status === 501) dropRelay(); continue; }
      const json = await res.json();
      if (json.result !== undefined) return json.result;
    } catch { /* next endpoint */ }
  }
  throw new Error('Arc RPC unavailable');
}
export const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

// ---------- ABI encoding (only what we call) ----------
const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');
const word = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
function bytesOf(text) {
  const hex = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return u256(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
}
export const encode = {
  createJob: (provider, evaluator, expiredAt, description, hook = ZERO) =>
    `0x41528812${word(provider)}${word(evaluator)}${u256(expiredAt)}${u256(0xa0)}${word(hook)}${bytesOf(description)}`,
  setBudget: (jobId, amount) => `0xdd4ae9d4${u256(jobId)}${u256(amount)}${u256(0x60)}${u256(0)}`,
  fund: (jobId) => `0xe25ba707${u256(jobId)}${u256(0x40)}${u256(0)}`,
  approve: (spender, amount) => `0x095ea7b3${word(spender)}${u256(amount)}`,
  balanceOf: (owner) => `0x70a08231${word(owner)}`,
};
export const usdcBalance = async (owner) => BigInt(await call(USDC, encode.balanceOf(owner)));

// ---------- explorer events (decoded) ----------
export async function escrowEvents() {
  const out = []; let params = '';
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`${EXPLORER}/api/v2/addresses/${CORE}/logs${params}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`explorer ${res.status}`);
    const json = await res.json();
    for (const it of json.items || []) {
      const dec = it.decoded || {};
      const name = (dec.method_call || '').split('(')[0];
      const args = Object.fromEntries((dec.parameters || []).map((p) => [p.name, p.value]));
      if (!name || args.jobId === undefined) continue;
      out.push({ name, jobId: Number(args.jobId), args, tx: it.transaction_hash, block: Number(it.block_number), at: it.block_timestamp, index: it.index });
    }
    if (!json.next_page_params) break;
    params = `?${new URLSearchParams(json.next_page_params)}`;
  }
  return out.sort((a, b) => a.block - b.block || a.index - b.index);
}

// ---------- wallet (EIP-1193) ----------
const ARC = { chainId: `0x${CHAIN_ID.toString(16)}`, chainName: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: ['https://rpc.testnet.arc.io'], blockExplorerUrls: [EXPLORER] };
export const hasWallet = () => typeof window !== 'undefined' && !!window.ethereum;
export async function connectWallet() {
  if (!hasWallet()) throw new Error('No browser wallet found. Install MetaMask or Rabby, then reload.');
  const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC.chainId }] }); }
  catch (e) {
    if (e.code !== 4902 && !/unrecognized|not added/i.test(e.message || '')) throw e;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [ARC] });
  }
  return account;
}
export async function sendTx(from, to, data) {
  return window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] });
}
export async function waitReceipt(hash, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r?.blockNumber) { if (r.status !== '0x1') throw new Error('Transaction reverted on Arc'); return r; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error('Timed out waiting for Arc to confirm');
}
export function jobIdFromReceipt(receipt) {
  const log = receipt.logs.find((l) => l.address.toLowerCase() === CORE.toLowerCase() && l.topics[0] === JOB_CREATED);
  if (!log) throw new Error('JobCreated event not found');
  return Number(BigInt(log.topics[1]));
}
