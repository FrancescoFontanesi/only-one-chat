import unittest
from decimal import Decimal
from shop.shipping.rates import rate

class RateTest(unittest.TestCase):
    def test_rate(self):
        self.assertEqual(rate(1), Decimal("4.90"))
