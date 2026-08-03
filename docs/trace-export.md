# Fine-tuning on your own traces (Layer 4)

Sigma Oasis exports training traces; it never trains. Training happens out of
band — MLX-LM, Unsloth, or llama.cpp LoRA — and the result comes back in
through LM Studio, where the Layer 0 eval harness scores it against the base
model on the same fixtures. Traces in, evidence out.

## 1. Export the traces

The audit log must be on (Settings → Privacy → Record a session audit log) for
turns to be recorded at all. Then either shell works — both run the same
exporter (`src/main/ipc/traceExport.ts`):

- **In-app:** Settings → Privacy → **Export traces (SFT)**. Pick a location;
  four files are written.
- **CLI:** first Settings → Privacy → Export latest (decrypted) to get a
  plaintext audit export, then
  `npm run export:traces -- <audit-export.jsonl> [--conversations <dir>] [--out <dir>]`

Outputs:

| File | Contents |
| --- | --- |
| `<base>-positive.jsonl` | Strict OpenAI lines (`{"messages":[...]}`) — turns that mechanically ended well |
| `<base>-rejected.jsonl` | Turns that errored, hit the iteration cap, or ended contradicted — the rejected half of preference pairs |
| `<base>-manifest.json` | Counts, per-trace labels + reasons, provenance, schema stamp |
| `<base>-tools.json` | The tool schemas these traces ran against |

**Labels come from outcomes, not vibes (4b).** A trace is positive only when
the turn ended well *mechanically*: no errored tool calls, a final answer
exists, and the reply was either never flagged unverified or every checked
claim came back confirmed. Turns the mechanics cannot settle — no outcome
data, claims left unverifiable — are unlabeled and excluded from both files.
The manifest's per-trace `reasons` say exactly why each trace landed where it
did.

**Redaction runs before anything is written (4a).** URLs, absolute paths,
email addresses, IPs/localhost, and key-shaped tokens are replaced with
placeholders in every field. Ephemeral chats never reach the audit log, so
they can never reach a trace. The export writes to local disk and never
uploads.

## 2. Check the schema stamp before training (4c)

`manifest.schemaVersion` and `tools.json` stamp each export with a content
hash of the tool schemas that produced it. If the app's tool schemas change
(new tools, renamed arguments), old traces become a syntax-drift generator —
compare the stamp against a fresh export's, and re-export or discard when they
differ. A few hundred consistent traces beat a thousand stale ones.

## 3. Train out of band

Any OpenAI-format LoRA trainer works. With MLX-LM on Apple silicon, e.g.:

```sh
mlx_lm.lora --model <base-model> --train \
  --data <dir-with-train.jsonl> --iters 600 --batch-size 4
```

(`positive.jsonl` splits directly into train/valid; `rejected.jsonl` is for
DPO-style preference training, paired by `conversationId` + `turnIndex` in the
manifest.) Convert or fuse the result to GGUF, drop it in LM Studio.

## 4. Evaluate in band

Load the fine-tuned model in LM Studio and run the same harness that judged
the base model:

```sh
LMSTUDIO_EVAL=1 npm run eval:tools -- <fine-tuned-model-id>
```

Compare correct-tool / spurious / arg-validity / loop rates against the base
model's `.eval-results/` run. If the numbers do not move, the traces did not
help — the harness, not hope, decides whether another round of data is worth
it. Honest expectation (strategy doc): a LoRA on your own traces reliably
fixes argument-format drift and tool selection *within your fixed toolbox*; it
does not teach delegation judgment.
