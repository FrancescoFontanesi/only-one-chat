import unittest
from decimal import Decimal
from shop.catalog.products import Product
from shop.catalog.search import search

class SearchTest(unittest.TestCase):
    def test_search(self):
        p = Product("a", "Red Mug", Decimal("5"))
        self.assertEqual(search([p], "mug"), [p])
