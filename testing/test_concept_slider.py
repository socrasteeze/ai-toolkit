"""Synthetic CPU regressions for Concept Slider conditioning."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import torch

from extensions_built_in.concept_slider.ConceptSliderTrainer import (
    ConceptSliderTrainer, ConceptSliderTrainerConfig,
)
from extensions_built_in.sd_trainer.DiffusionTrainer import DiffusionTrainer
from toolkit.prompt_utils import PromptEmbeds
from toolkit.concept_slider import expand_slider_batch
from toolkit.data_transfer_object.data_loader import DataLoaderBatchDTO


class SliderConditioningTest(unittest.TestCase):
    def trainer(self, anchor, image_prompts=False):
        trainer = object.__new__(ConceptSliderTrainer)
        trainer.device_torch = torch.device('cpu')
        trainer.train_config = SimpleNamespace(dtype='float32', unload_text_encoder=True)
        trainer.is_caching_text_embeddings = True
        trainer.slider = ConceptSliderTrainerConfig(anchor_class='anchor' if anchor else None)
        trainer.network = SimpleNamespace(is_active=True, multiplier=1.0)
        trainer.network.set_multiplier = lambda value: setattr(trainer.network, 'multiplier', value)
        trainer.sd = SimpleNamespace(
            unet=torch.nn.Linear(1, 1), torch_dtype=torch.float32,
            encode_control_in_text_embeddings=image_prompts,
        )
        trainer.sd.unet.train()
        for i, name in enumerate(('positive_prompt', 'target_class', 'negative_prompt', 'anchor_class')):
            setattr(trainer, name, name if name != 'anchor_class' or anchor else None)
            setattr(trainer, name + '_embeds', PromptEmbeds(torch.full((1, 2, 1), float(i + 1)))
                    if name != 'anchor_class' or anchor else None)
        return trainer

    def batch(self, size, kind):
        controls = torch.arange(size * 12, dtype=torch.float32).reshape(size, 3, 2, 2) / 24
        return SimpleNamespace(
            control_tensor=controls if kind == 'tensor' else None,
            control_tensor_list=[[image, image + 1] for image in controls] if kind == 'list' else None,
            file_items=[SimpleNamespace(crop_width=16, crop_height=16) for _ in range(size)],
            tensor=None,
        )

    def test_predictions_keep_controls_in_prompt_block_order(self):
        for size in (1, 2):
            for anchor in (False, True):
                for kind in ('none', 'tensor', 'list'):
                    with self.subTest(size=size, anchor=anchor, kind=kind):
                        trainer = self.trainer(anchor)
                        batch = self.batch(size, kind)
                        controls = batch.control_tensor
                        nested = batch.control_tensor_list
                        calls = []
                        weight = torch.nn.Parameter(torch.tensor(0.25))
                        latents = torch.arange(size * 4, dtype=torch.float32).reshape(size, 1, 2, 2)

                        def predict(**kwargs):
                            factor = (4 if anchor else 3) if not calls else (2 if anchor else 1)
                            calls.append(factor)
                            active = kwargs['batch']
                            torch.testing.assert_close(kwargs['latents'], torch.cat([latents] * factor))
                            self.assertEqual(kwargs['conditional_embeddings'].text_embeds.shape[0], size * factor)
                            self.assertEqual(kwargs['timestep'].shape[0], size * factor)
                            self.assertEqual(kwargs['guidance_scale'], 1.0)
                            self.assertEqual(kwargs['guidance_embedding_scale'], 1.0)
                            self.assertEqual(len(active.file_items), size * factor)
                            if controls is not None:
                                torch.testing.assert_close(active.control_tensor, torch.cat([controls] * factor))
                            if nested is not None:
                                self.assertEqual(len(active.control_tensor_list), size * factor)
                                for i, images in enumerate(active.control_tensor_list):
                                    self.assertEqual(len(images), 2)
                                    torch.testing.assert_close(images[0], nested[i % size][0])
                            return kwargs['latents'] + weight * trainer.network.multiplier

                        trainer.sd.predict_noise = predict
                        loss = trainer.get_guided_loss(
                            latents, None, False, [1.0] * size, torch.ones(size), {}, batch, latents,
                        )
                        self.assertEqual(calls, [4 if anchor else 3, 2 if anchor else 1, 2 if anchor else 1])
                        self.assertTrue(torch.isfinite(loss))
                        self.assertIsNotNone(weight.grad)
                        self.assertTrue(torch.isfinite(weight.grad))
                        self.assertTrue(trainer.sd.unet.training)
                        self.assertTrue(trainer.network.is_active)
                        self.assertEqual(trainer.network.multiplier, 1.0)
                        self.assertIs(batch.control_tensor, controls)
                        self.assertIs(batch.control_tensor_list, nested)
                        self.assertEqual(len(batch.file_items), size)

    def test_image_prompt_startup_keeps_encoder_and_skips_static_slider_cache(self):
        trainer = self.trainer(True, image_prompts=True)
        trainer.sd.encode_prompt = lambda *args, **kwargs: self.fail('Cannot encode slider prompts before a batch exists')
        with patch.object(DiffusionTrainer, 'hook_before_train_loop') as parent:
            trainer.hook_before_train_loop()
        parent.assert_called_once()
        self.assertFalse(trainer.is_caching_text_embeddings)
        self.assertFalse(trainer.train_config.unload_text_encoder)

    def test_plain_prompt_startup_preserves_cache_settings(self):
        trainer = self.trainer(True)
        calls = []
        def encode(prompts):
            calls.append(prompts)
            return PromptEmbeds(torch.ones(1, 2, 1))
        trainer.sd.encode_prompt = encode
        with patch.object(DiffusionTrainer, 'hook_before_train_loop'):
            trainer.hook_before_train_loop()
        self.assertEqual(len(calls), 4)
        self.assertTrue(trainer.is_caching_text_embeddings)
        self.assertTrue(trainer.train_config.unload_text_encoder)

    def test_expansion_preserves_dto_and_original_containers(self):
        batch = object.__new__(DataLoaderBatchDTO)
        batch.__dict__.update(vars(self.batch(2, 'list')))
        batch.control_tensor = torch.arange(24).reshape(2, 3, 2, 2)
        original = batch.control_tensor.clone()
        self.assertIs(expand_slider_batch(batch, 1), batch)
        for factor in (2, 3, 4):
            expanded = expand_slider_batch(batch, factor)
            self.assertIsInstance(expanded, DataLoaderBatchDTO)
            self.assertEqual(expanded.control_tensor.shape, (2 * factor, 3, 2, 2))
            self.assertEqual(len(expanded.control_tensor_list), 2 * factor)
            torch.testing.assert_close(expanded.control_tensor, torch.cat([original] * factor))
            expanded.control_tensor.zero_()
            expanded.control_tensor_list[0].append(torch.zeros(3, 2, 2))
            expanded.file_items.pop()
            torch.testing.assert_close(batch.control_tensor, original)
            self.assertEqual(len(batch.control_tensor_list[0]), 2)
            self.assertEqual(len(batch.file_items), 2)

    def test_image_prompts_follow_current_batch(self):
        for anchor in (False, True):
            for kind in ('tensor', 'list'):
                with self.subTest(anchor=anchor, kind=kind):
                    trainer = self.trainer(anchor, image_prompts=True)
                    weight = torch.nn.Parameter(torch.tensor(0.25))
                    latents = torch.arange(8, dtype=torch.float32).reshape(2, 1, 2, 2)
                    for offset in (0.0, 0.5):
                        batch = self.batch(2, kind)
                        if kind == 'tensor':
                            batch.control_tensor += offset
                        else:
                            for images in batch.control_tensor_list:
                                for image in images:
                                    image.add_(offset)
                        encoded = []
                        calls = []
                        values = (batch.control_tensor if kind == 'tensor' else
                                  torch.stack([images[0] for images in batch.control_tensor_list]))[:, 0, 0, 0]

                        def encode(prompts, control_images, target_size):
                            self.assertFalse(torch.is_grad_enabled())
                            self.assertFalse(trainer.network.is_active)
                            self.assertEqual(len(prompts), 2)
                            self.assertEqual(target_size, (16, 16))
                            if kind == 'tensor':
                                torch.testing.assert_close(control_images, batch.control_tensor)
                            else:
                                self.assertIs(control_images, batch.control_tensor_list)
                            encoded.append(prompts)
                            # Different prompt lengths exercise mask padding in combo embeds.
                            length = len(encoded) + 1
                            return PromptEmbeds(values[:, None, None].expand(2, length, 1).clone(),
                                                attention_mask=torch.ones(2, length, dtype=torch.int64))

                        def predict(**kwargs):
                            factor = (4 if anchor else 3) if not calls else (2 if anchor else 1)
                            calls.append(factor)
                            embeds = kwargs['conditional_embeddings']
                            torch.testing.assert_close(embeds.text_embeds[:, 0, 0], values.repeat(factor))
                            self.assertEqual(embeds.attention_mask.shape[0], 2 * factor)
                            return kwargs['latents'] + weight * trainer.network.multiplier

                        trainer.sd.encode_prompt = encode
                        trainer.sd.predict_noise = predict
                        loss = trainer.get_guided_loss(
                            latents, None, False, [1.0, 1.0], torch.ones(2), {}, batch, latents,
                        )
                        expected = ['positive_prompt', 'target_class', 'negative_prompt']
                        if anchor:
                            expected.append('anchor_class')
                        self.assertEqual(encoded, [[name, name] for name in expected])
                        self.assertTrue(torch.isfinite(loss))
                        self.assertTrue(torch.isfinite(weight.grad))


if __name__ == '__main__':
    unittest.main()
