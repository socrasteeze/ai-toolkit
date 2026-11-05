"""Fork helpers for Concept Slider control conditioning."""
from copy import copy

import torch

from toolkit.prompt_utils import concat_prompt_embeds


def expand_slider_batch(batch, factor):
    """Repeat controls in whole-batch order, matching torch.cat([latents] * k)."""
    if factor == 1:
        return batch
    expanded = copy(batch)
    if batch.control_tensor is not None:
        expanded.control_tensor = torch.cat([batch.control_tensor] * factor, dim=0)
    if batch.control_tensor_list is not None:
        expanded.control_tensor_list = [
            list(images) for _ in range(factor) for images in batch.control_tensor_list
        ]
    expanded.file_items = batch.file_items * factor
    return expanded


def slider_prompt_embeds(trainer, batch, batch_size, dtype):
    """Image-aware prompts must be encoded against this step's control images."""
    names = ['positive_prompt', 'target_class', 'negative_prompt']
    if trainer.anchor_class is not None:
        names.append('anchor_class')
    prompt_kwargs = {}
    image_prompts = trainer.sd.encode_control_in_text_embeddings
    if image_prompts:
        controls = batch.control_tensor_list
        if controls is None and batch.control_tensor is not None:
            controls = batch.control_tensor.to(trainer.device_torch, dtype=trainer.sd.torch_dtype)
        prompt_kwargs = dict(
            control_images=controls, target_size=trainer.get_batch_target_size(batch),
        )
    embeds = []
    for name in names:
        if image_prompts:
            value = trainer.sd.encode_prompt([getattr(trainer, name)] * batch_size, **prompt_kwargs)
        else:
            value = concat_prompt_embeds([getattr(trainer, name + '_embeds')] * batch_size)
        embeds.append(value.to(trainer.device_torch, dtype=dtype).detach())
    return embeds
