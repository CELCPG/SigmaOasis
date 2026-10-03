# Recorded model-server payloads (4.5, H4a)

Recorded from this PC on 2026-10-03 with `curl -s -m 5` (GET only, never a completion), unedited:

| file | request |
| --- | --- |
| `llamacpp-gemma-4-26b-a4b.v1-models.json` | `GET http://127.0.0.1:8084/v1/models` (llama-server b11026, vision) |
| `llamacpp-gemma-4-26b-a4b.props.json` | `GET http://127.0.0.1:8084/props` |
| `llamacpp-qwen3.8-35b-a3b.v1-models.json` | `GET http://127.0.0.1:8081/v1/models` (llama-server b11026, text only, 3 slots) |
| `llamacpp-qwen3.8-35b-a3b.props.json` | `GET http://127.0.0.1:8081/props` |
| `lmstudio.api-v0-models.json` | `GET http://127.0.0.1:1234/api/v0/models` (LM Studio) |
| `lmstudio.v1-models.json` | `GET http://127.0.0.1:1234/v1/models` (LM Studio) |

`/props` carries the model's whole chat template, so the two files are large; they are kept whole
because the point is what the build really sends. The local paths in `model_path` are this PC's.
Used by `test/catalogLlamaCpp.test.ts`.
