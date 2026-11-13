import torch
from pathlib import Path
from safetensors.torch import load_file
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

torch.set_num_threads(2)

MODEL = "facebook/nllb-200-distilled-600M"

root = Path.home() / ".cache/huggingface/hub/models--facebook--nllb-200-distilled-600M"

weights_path = next(root.glob("snapshots/*/model.safetensors")).resolve()

print("Loading tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(MODEL, src_lang="kor_Hang")

print("Loading model configuration and architecture...")
model = AutoModelForSeq2SeqLM.from_pretrained(
    MODEL,
    use_safetensors=True,
    low_cpu_mem_usage=True
)

print("Reading shared embedding tensor...")
weights = load_file(str(weights_path), device="cpu")
shared_weight = weights["lm_head.weight"]

print("Restoring shared embeddings...")
model.model.shared.weight = torch.nn.Parameter(shared_weight)

model.tie_weights()
model.eval()

meta = [name for name, param in model.named_parameters() if param.is_meta]

print("\nRemaining meta parameters:", len(meta))
for name in meta[:10]:
    print(name)

if meta:
    raise RuntimeError("Model still has unloaded parameters.")

print("\nTesting Korean translation...")

text = "이까짓 일로 왜 널 좋아해서 했던 내 행동을 기만으로 만들어."

inputs = tokenizer(text, return_tensors="pt")

with torch.inference_mode():
    output = model.generate(
        **inputs,
        forced_bos_token_id=tokenizer.convert_tokens_to_ids("eng_Latn"),
        max_new_tokens=128,
        num_beams=2
    )

print("\nTranslation:")
print(tokenizer.batch_decode(output, skip_special_tokens=True)[0])
print("\nRepair test completed successfully.")
