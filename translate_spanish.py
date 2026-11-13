
import sys
import time
import torch
from transformers import MarianMTModel, MarianTokenizer

MODEL_NAME = "Helsinki-NLP/opus-mt-es-en"

if len(sys.argv) < 2:
    print("Usage: python translate_spanish.py 'Spanish text'")
    sys.exit(1)

text = " ".join(sys.argv[1:])

print("Loading Spanish-English translation model...")
start = time.time()

tokenizer = MarianTokenizer.from_pretrained(MODEL_NAME)
model = MarianMTModel.from_pretrained(MODEL_NAME)
model.eval()

print(f"Model loaded in {time.time() - start:.2f}s")

print("\nTranslating...")
start = time.time()

inputs = tokenizer(
    [text],
    return_tensors="pt",
    padding=True,
    truncation=True,
    max_length=256
)

with torch.inference_mode():
    translated = model.generate(
        **inputs,
        max_new_tokens=256,
        num_beams=2
    )

result = tokenizer.decode(
    translated[0],
    skip_special_tokens=True
)

print("\nEnglish translation:")
print(result)

print(f"\nTranslation time: {time.time() - start:.2f}s")
