"""A few unit tests of the reference calculator (python -m unittest)."""

import unittest

from evaluator import evaluate, format_value
from lexer import CalcError


def calc(line, variables=None):
    value, _ = evaluate(line, {} if variables is None else variables)
    return format_value(value)


class CalculatorTest(unittest.TestCase):
    def test_precedence_and_power(self):
        self.assertEqual(calc("2 + 3 * 4"), "14")
        self.assertEqual(calc("-2 ^ 2"), "-4")
        self.assertEqual(calc("2 ^ 3 ^ 2"), "512")
        self.assertEqual(calc("2 ^ -1"), "0.5")

    def test_variables(self):
        variables = {}
        evaluate("x = 4", variables)
        self.assertEqual(calc("x * 2", variables), "8")

    def test_errors(self):
        with self.assertRaisesRegex(CalcError, "division by zero"):
            calc("1 / 0")
        with self.assertRaises(CalcError) as caught:
            calc("(1 + 2")
        self.assertEqual(caught.exception.column, 7)


if __name__ == "__main__":
    unittest.main()
