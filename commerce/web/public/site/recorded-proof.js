const explorer = 'https://explorer.testnet.arc.io/tx/';

function fromHex(hex) {
  if (!/^0x(?:[\da-f]{2})+$/i.test(hex)) throw new Error('Invalid recorded bytes');
  return Uint8Array.from(hex.slice(2).match(/../g), byte => Number.parseInt(byte, 16));
}

async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return '0x' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyDelivery(run) {
  const envelope = fromHex(run.envelopeHex);
  const prefix = new TextEncoder().encode('UBC26/key/v1');
  const context = fromHex(run.contextHex);
  const key = fromHex(run.key);
  const committedKey = new Uint8Array(prefix.length + context.length + key.length);
  committedKey.set(prefix);
  committedKey.set(context, prefix.length);
  committedKey.set(key, prefix.length + context.length);
  const [envelopeHash, keyCommitment] = await Promise.all([sha256(envelope), sha256(committedKey)]);
  if (envelopeHash !== run.envelopeHash || keyCommitment !== run.keyCommitment) {
    throw new Error('The recorded delivery or key does not match its commitment.');
  }
}

export function initRecordedProof() {
  const button = document.getElementById('proof-next');
  const detail = document.getElementById('proof-detail');
  const receipt = document.getElementById('proof-receipt');
  const files = document.getElementById('proof-files');
  const stages = [...document.querySelectorAll('[data-proof-stage]')];
  const labels = ['Show Arc verification', 'Show payout', 'Check the delivery', 'Restart replay'];
  let run;
  let stage = -1;

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (!run) {
        const response = await fetch(new URL('./recorded-invoice.json', import.meta.url));
        if (!response.ok) throw new Error('Recording unavailable');
        run = await response.json();
      }
      const next = stage === 3 ? -1 : stage + 1;
      if (next === 3) await verifyDelivery(run);
      stage = next;
      const time = (run.proof.proveMillis / 1000).toFixed(1);
      const descriptions = [
        `The solver produced a ${run.proof.sealBytes}-byte proof in ${time} seconds. The agreed checks passed.`,
        'The Arc verifier accepted the proof in the recorded submit transaction.',
        'One confirmed release transaction paid the solver 0.01 testnet USDC and published the delivery key.',
        'This browser matched the encrypted delivery and released key to the recorded commitments. Inspect the files recovered in the original run.',
      ];
      detail.textContent = descriptions[stage] ?? 'Step through the historical run at your own pace.';
      button.textContent = labels[stage] ?? 'Show the proof';
      stages.forEach((item, index) => {
        item.classList.toggle('complete', index <= stage);
        if (index === stage) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      });
      receipt.hidden = stage < 1;
      if (!receipt.hidden) {
        receipt.href = explorer + (stage === 1 ? run.submitTx : run.releaseTx);
        receipt.textContent = stage === 1 ? 'View proof acceptance receipt ↗' : 'View payout and key receipt ↗';
      }
      files.hidden = stage !== 3;
      if (!files.hidden) {
        files.replaceChildren(...run.files.map(file => {
          const disclosure = document.createElement('details');
          const name = document.createElement('summary');
          const content = document.createElement('pre');
          name.textContent = file.name;
          content.textContent = file.text;
          disclosure.append(name, content);
          return disclosure;
        }));
      }
    } catch (error) {
      detail.textContent = error.message === 'The recorded delivery or key does not match its commitment.'
        ? error.message
        : 'The recorded evidence could not be checked here. The Arc results below still link to the original transactions.';
    } finally {
      button.disabled = false;
    }
  });
}
