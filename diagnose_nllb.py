import torch
import transformers

from transformers import AutoModelForSeq2SeqLM

MODEL = "facebook/nllb-200-distilled-600M"

print("PyTorch:", torch.__version__)
print("Transformers:", transformers.__version__)
print("\nLoading safetensors model...")

model, info = AutoModelForSeq2SeqLM.from_pretrained(
    MODEL,
    use_safetensors=True,
    low_cpu_mem_usage=True,
    output_loading_info=True
)

meta = [
    name for name, param in model.named_parameters()
    if param.is_meta
]

print("\nMissing keys:", len(info["missing_keys"]))
print("Unexpected keys:", len(info["unexpected_keys"]))
print("Mismatched keys:", len(info["mismatched_keys"]))
print("Parameters still on meta device:", len(meta))

if meta:
    print("\nFirst missing parameters:")
    for name in meta[:20]:
        print(name)

print("\nModel diagnostic complete.")
