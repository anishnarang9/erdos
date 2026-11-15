import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getAddress, zeroAddress, zeroHash } from "viem";
import { parseDeploymentPolicy } from "../../src/deployment-policy.ts";

it("keeps the published SDK manifest byte-identical to the settlement manifest", () => {
  const settlement = readFileSync(new URL("../../../../contracts/deployments/arc-testnet.json", import.meta.url));
  const sdk = readFileSync(new URL("../../../sdk/src/chain/arc/arc-testnet.json", import.meta.url));
  expect(sdk.equals(settlement)).toBe(true);
  expect(parseDeploymentPolicy(JSON.parse(settlement.toString("utf8"))).policy.deploymentBlock).toBe(72393888n);
});

// Relevant fields from Nick's frozen manifest at 57c387f96a7ca8ecc48dc7aa932b1820d578f653.
// These are parser fixtures, not approved trust roots or independent chain evidence.
function fixture() {
  return {
    schemaVersion: 1,
    network: "arc-testnet",
    status: "frozen",
    chain: { chainId: 5042002 },
    usdc: { address: "0x3600000000000000000000000000000000000000", decimals: 6 },
    contracts: {
      core: {
        address: "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8",
        implementation: "0x55A3C9319EEe607579855880b5651766eBF103d7",
        runtimeCodeHash: "0xdac3085f81cca92bb363b27a29074c33a338ba3c89cc395dc097ba20fac576d7",
        deployBlock: 72393888,
        frozen: true,
        frozenBlock: 72472534,
      },
      coreImplementation: {
        address: "0x55A3C9319EEe607579855880b5651766eBF103d7",
        runtimeCodeHash: "0x7bdd6ba79fb1560523b2228edf03bef923f33edf41de728044de5ccae4037d13",
      },
      hook: {
        address: "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb",
        runtimeCodeHash: "0x69d39f1e4b10380698a0f1ce227a6f8de6fa368ecc1aceab73c64b51ad571cd0",
      },
      verifier: {
        address: "0xCf8D70A203b40D3A17d023c0CDDF752870BC3992",
        runtimeCodeHash: "0x0b496507a375b268f944877d4057cb475d412ea3f9376d406ae40a13fea49012",
        version: "3.1.0",
        selector: "0xe71e6620",
      },
    },
    evidence: { block: 72472573 },
  };
}

function replace(manifest: unknown, path: string, value: unknown) {
  const parts = path.split(".");
  let record = manifest as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) record = record[part] as Record<string, unknown>;
  if (value === undefined) delete record[parts.at(-1)!];
  else record[parts.at(-1)!] = value;
}

const addressPaths = ["contracts.core.address", "contracts.hook.address", "usdc.address",
  "contracts.coreImplementation.address", "contracts.verifier.address", "contracts.core.implementation"];
const hashPaths = ["core", "coreImplementation", "hook", "verifier"].map(name => `contracts.${name}.runtimeCodeHash`);

describe("deployment policy candidate parser", () => {
  it("maps Nick's frozen manifest fields without approving a deployment", () => {
    const manifest = fixture();
    const candidate = parseDeploymentPolicy(manifest);
    expect(candidate.kind).toBe("deployment-policy-candidate");
    expect(candidate.authorization).toBe("not-authorized");
    expect(candidate.chainConfig).toEqual({
      chainId: 5042002, core: getAddress(manifest.contracts.core.address),
      hook: getAddress(manifest.contracts.hook.address), usdc: getAddress(manifest.usdc.address),
    });
    expect(candidate.policy).toEqual({
      deploymentBlock: 72393888n,
      implementation: getAddress(manifest.contracts.coreImplementation.address),
      verifier: getAddress(manifest.contracts.verifier.address),
      verifierVersion: "3.1.0", verifierSelector: "0xe71e6620",
      runtimeHashes: {
        core: manifest.contracts.core.runtimeCodeHash,
        implementation: manifest.contracts.coreImplementation.runtimeCodeHash,
        hook: manifest.contracts.hook.runtimeCodeHash,
        verifier: manifest.contracts.verifier.runtimeCodeHash,
      },
    });
  });

  it("normalizes address and hash case, including the duplicate implementation pin", () => {
    const manifest = fixture();
    for (const path of addressPaths) {
      const original = path === "usdc.address" ? manifest.usdc.address
        : path === "contracts.core.implementation" ? manifest.contracts.core.implementation
        : manifest.contracts[path.split(".")[1] as keyof typeof manifest.contracts].address;
      replace(manifest, path, original.toLowerCase());
    }
    manifest.contracts.core.implementation = manifest.contracts.core.implementation.toUpperCase().replace("0X", "0x");
    for (const contract of Object.values(manifest.contracts)) {
      contract.runtimeCodeHash = contract.runtimeCodeHash.toUpperCase().replace("0X", "0x");
    }
    const candidate = parseDeploymentPolicy(manifest);
    expect(candidate.chainConfig.core).toBe(getAddress(manifest.contracts.core.address));
    expect(candidate.policy.implementation).toBe(getAddress(manifest.contracts.coreImplementation.address));
    expect(candidate.policy.verifier).toBe(getAddress(manifest.contracts.verifier.address));
    for (const hash of Object.values(candidate.policy.runtimeHashes)) expect(hash).toBe(hash.toLowerCase());
  });

  it("copies and deeply freezes output without freezing or changing input", () => {
    const manifest = fixture(), before = structuredClone(manifest);
    const candidate = parseDeploymentPolicy(manifest);
    expect(manifest).toEqual(before);
    for (const object of [candidate, candidate.chainConfig, candidate.policy, candidate.policy.runtimeHashes]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
    expect(Reflect.set(candidate.chainConfig, "core", zeroAddress)).toBe(false);
    expect(Reflect.set(candidate.policy, "deploymentBlock", 1n)).toBe(false);
    expect(Reflect.set(candidate.policy.runtimeHashes, "core", zeroHash)).toBe(false);
    expect(Reflect.set(candidate, "authorization", "authorized")).toBe(false);
    manifest.contracts.core.deployBlock = 1;
    manifest.contracts.core.runtimeCodeHash = zeroHash;
    manifest.contracts.hook.address = zeroAddress;
    expect(candidate.policy.deploymentBlock).toBe(72393888n);
    expect(candidate.policy.runtimeHashes.core).toBe(before.contracts.core.runtimeCodeHash);
    expect(candidate.chainConfig.hook).toBe(getAddress(before.contracts.hook.address));
  });

  it.each([undefined, null, [], true, 1, "secret-input", {}])("rejects a malformed root (%s)", value => {
    expect(() => parseDeploymentPolicy(value)).toThrow(/^InvalidDeploymentManifest$/);
  });

  it.each([
    ["schemaVersion", undefined], ["schemaVersion", 2], ["schemaVersion", "1"],
    ["network", undefined], ["network", "mainnet"], ["status", undefined], ["status", "whitelisted"],
    ["chain", undefined], ["chain", []], ["chain.chainId", undefined], ["chain.chainId", 1],
    ["chain.chainId", "5042002"], ["usdc", null], ["usdc.decimals", undefined], ["usdc.decimals", 18],
    ["usdc.decimals", "6"], ["contracts", undefined], ["contracts", []],
    ["contracts.core", undefined], ["contracts.hook", undefined], ["contracts.coreImplementation", undefined],
    ["contracts.verifier", undefined], ["contracts.core.frozen", undefined], ["contracts.core.frozen", false],
    ["contracts.core.frozen", "true"], ["contracts.core.implementation", "0x1111111111111111111111111111111111111111"],
    ["contracts.verifier.version", undefined], ["contracts.verifier.version", "3.0.0"],
    ["contracts.verifier.selector", undefined], ["contracts.verifier.selector", "0x00000000"],
    ["contracts.verifier.selector", "0xe71e662000"], ["contracts.core.deployBlock", undefined],
  ])("rejects invalid required field %s = %s", (path, value) => {
    const manifest = fixture(); replace(manifest, path as string, value);
    expect(() => parseDeploymentPolicy(manifest)).toThrow(/^InvalidDeploymentManifest$/);
  });

  for (const path of addressPaths) {
    it.each([undefined, null, zeroAddress, "", "0x1234", `0x${"g".repeat(40)}`, `0x${"1".repeat(42)}`,
      `0x${"a".repeat(40)}\n`, ` 0x${"a".repeat(40)}`, 42])
      (`rejects invalid ${path} (%s)`, value => {
        const manifest = fixture(); replace(manifest, path, value);
        expect(() => parseDeploymentPolicy(manifest)).toThrow(/^InvalidDeploymentManifest$/);
      });
  }

  const distinctAddressPaths = addressPaths.slice(0, -1);
  for (let i = 0; i < distinctAddressPaths.length; i++) {
    for (const path of distinctAddressPaths.slice(i + 1)) {
      it(`rejects duplicate addresses ${distinctAddressPaths[i]} and ${path}`, () => {
        const manifest = fixture(), duplicate = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        replace(manifest, distinctAddressPaths[i]!, duplicate);
        replace(manifest, path, duplicate.toUpperCase().replace("0X", "0x"));
        if ([path, distinctAddressPaths[i]].includes("contracts.coreImplementation.address")) {
          manifest.contracts.core.implementation = duplicate;
        }
        expect(() => parseDeploymentPolicy(manifest)).toThrow(/^InvalidDeploymentManifest$/);
      });
    }
  }

  for (const path of hashPaths) {
    it.each([undefined, null, zeroHash, "", "0x1234", `0x${"g".repeat(64)}`, `0x${"a".repeat(66)}`,
      `0x${"a".repeat(64)}\n`, ` 0x${"a".repeat(64)}`, 42])
      (`rejects invalid ${path} (%s)`, value => {
        const manifest = fixture(); replace(manifest, path, value);
        expect(() => parseDeploymentPolicy(manifest)).toThrow(/^InvalidDeploymentManifest$/);
      });
  }

  for (const path of ["contracts.core.deployBlock", "contracts.core.frozenBlock", "evidence.block"]) {
    it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "72393888", 72393888n, true])
      (`rejects invalid block ${path} (%s)`, value => {
        const manifest = fixture(); replace(manifest, path, value);
        expect(() => parseDeploymentPolicy(manifest)).toThrow(/^InvalidDeploymentManifest$/);
      });
  }

  it.each(["contracts.core.frozenBlock", "evidence.block"])("rejects deployment after %s", path => {
    const manifest = fixture(); replace(manifest, path, manifest.contracts.core.deployBlock - 1);
    expect(() => parseDeploymentPolicy(manifest)).toThrow(/^InvalidDeploymentManifest$/);
  });

  it("accepts equal block bounds and never substitutes them for the deployment block", () => {
    const manifest = fixture();
    manifest.contracts.core.frozenBlock = manifest.evidence.block = manifest.contracts.core.deployBlock;
    expect(parseDeploymentPolicy(manifest).policy.deploymentBlock).toBe(72393888n);
    replace(manifest, "contracts.core.deployBlock", undefined);
    expect(() => parseDeploymentPolicy(manifest)).toThrow(/^InvalidDeploymentManifest$/);
  });

  it("accepts absent optional freeze and evidence blocks", () => {
    const manifest = fixture();
    replace(manifest, "contracts.core.frozenBlock", undefined);
    replace(manifest, "evidence", undefined);
    expect(parseDeploymentPolicy(manifest).policy.deploymentBlock).toBe(72393888n);
  });

  it("converts the largest safe deployment block exactly", () => {
    const manifest = fixture();
    manifest.contracts.core.deployBlock = manifest.contracts.core.frozenBlock = manifest.evidence.block = Number.MAX_SAFE_INTEGER;
    expect(parseDeploymentPolicy(manifest).policy.deploymentBlock).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("does not expose arbitrary input or errors from property access", () => {
    const manifest = fixture(); manifest.contracts.core.address = "private-secret-value";
    expect(() => parseDeploymentPolicy(manifest)).toThrow(/^InvalidDeploymentManifest$/);
    const hostile = Object.defineProperty({}, "schemaVersion", { get() { throw new Error("private-secret-value"); } });
    expect(() => parseDeploymentPolicy(hostile)).toThrow(/^InvalidDeploymentManifest$/);
  });
});
