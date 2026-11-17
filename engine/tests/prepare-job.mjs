import { readFileSync } from 'node:fs';

function uint256(text, name) {
  if (!/^(0|[1-9][0-9]{0,77})(?![\s\S])/.test(text)) {
    throw new Error(`Expected ${name} as canonical unsigned decimal`);
  }
  const hex = BigInt(text).toString(16);
  if (hex.length > 64) {
    throw new Error(`${name} exceeds uint256`);
  }
  return hex.padStart(64, '0');
}

function hexBytes(text, bytes, name) {
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (typeof text !== 'string' || text.length !== 2 + bytes * 2 || !pattern.test(text)) {
    throw new Error(`Expected ${name} as ${bytes}-byte 0x-prefixed hex`);
  }
  return text.slice(2).toLowerCase();
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 5) {
    throw new Error('Usage: node prepare-job.mjs PACKAGE_MANIFEST CHAIN_ID ESCROW JOB_ID PROVIDER');
  }
  const [manifestPath, chainId, escrow, jobId, provider] = args;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.version !== 1) {
    throw new Error('Expected a version 1 package manifest');
  }
  const imageId = '0x' + hexBytes(manifest.imageId, 32, 'imageId');
  const context = '0x' + [
    '01',
    uint256(chainId, 'chain ID'),
    hexBytes(escrow, 20, 'escrow'),
    uint256(jobId, 'job ID'),
    hexBytes(provider, 20, 'provider'),
    hexBytes(manifest.rulesHash, 32, 'rulesHash'),
    hexBytes(manifest.referenceHash, 32, 'referenceHash'),
  ].join('');
  process.stdout.write(JSON.stringify({ context, imageId }) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 2;
}
