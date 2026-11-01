"""Checkpoint Compare likeness scorer (see FORK_NOTES.md).

stdin:  {"reference": path, "images": [paths]}
stdout: {"method": str, "scores": {path: cosine similarity}}

CLIP image similarity on CPU, so it never competes with the engine for VRAM. Uses only
weights already in the Hugging Face cache and refuses to download 1.7 GB on its own.
"""
import json
import sys

REPO = "timm/vit_large_patch14_clip_224.openai"
WEIGHTS = "open_clip_model.safetensors"
METHOD = "CLIP ViT-L/14 image similarity (whole image, not face identity)"


def cosine_scores(reference, images):
    import torch
    import open_clip
    from huggingface_hub import try_to_load_from_cache
    from PIL import Image

    weights = try_to_load_from_cache(REPO, WEIGHTS)
    if not isinstance(weights, str):
        sys.exit(f"CLIP weights are not cached. Download {WEIGHTS} from {REPO} to enable scoring.")
    # OpenAI's checkpoints were trained with QuickGELU; the plain config would skew the features
    model, _, preprocess = open_clip.create_model_and_transforms("ViT-L-14-quickgelu", pretrained=weights)
    model.eval()

    def embed(path):
        with Image.open(path) as im:
            x = preprocess(im.convert("RGB")).unsqueeze(0)
        with torch.no_grad():
            f = model.encode_image(x)
        return f / f.norm(dim=-1, keepdim=True)

    ref = embed(reference)
    return {p: float((ref * embed(p)).sum()) for p in images}


def main():
    request = json.load(sys.stdin)
    print(json.dumps({"method": METHOD, "scores": cosine_scores(request["reference"], request["images"])}))


if __name__ == "__main__":
    main()
