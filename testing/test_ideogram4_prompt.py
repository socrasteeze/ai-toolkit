import unittest

from extensions_built_in.captioner.prompts.ideogram4_prompt import ideogram4_prompt


class Ideogram4PromptTest(unittest.TestCase):
    def test_backslash_examples_remain_literal(self):
        self.assertIn(r"\uNNNN", ideogram4_prompt)
        self.assertIn(r'"ENTRE\nVERSOS E\nCONTOS"', ideogram4_prompt)


if __name__ == "__main__":
    unittest.main()
