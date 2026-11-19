# Model-authored pier proof

The exact selected revision from task `01M7R53BZ7CEYT30V2GN2WX8GJ` on API source `eb22e28` compiled locally from an empty cache in 45,128 ms. The engine generated a new verdict-1 Groth16 proof in 296,325 ms with 899,628 guest cycles. The compiled manifest matched the job and proof image ID. The synthetic context carried the compiled rules and reference hashes.

| Artifact | SHA-256 |
| --- | --- |
| Exact draft plan | `37a837b6adc15585875a0e345172c96a74cba7e59280cd7255b2bd0e452325c7` |
| Package manifest | `adc1b60c5e9dc9494a35f859f20ecbaa36de55efc0fdb24fe07343c7e15df430` |
| Proof JSON | `61c1d3cdedb68389849c2b9fef738f4d5e901d55093027ebcdef8da918ff30d7` |
| Submitted and recovered drawers.json | `a0186148eb6de458df93148d6ba37b3894785e90baa3edf5bfd3f2f360a0e3d9` |

The engine decrypted the exact bytes from the synthetic proof using its release key. A separate oracle evaluated the recovered file against the unchanged references and returned pass. The positive example came from the draft. This used a local synthetic job. It did not include buyer approval, Bot review, or Arc funding, claim, release or payout.

The initial proof command failed before proof generation because its synthetic job used a placeholder image ID. After binding the compiled image ID, a second preflight failed because the shell inherited prover settings the CLI disallows. The successful run used the corrected job and cleared those variables. The original plan and reference files stayed intact. Private proof artifacts and journals remain in the protected operator directory.

- [Live draft evidence](authoring-lookup-guard-trial-2026-11-18.md)
