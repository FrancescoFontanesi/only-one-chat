import unittest

from shop.orders.checkout import order_total


class OrderTotalTest(unittest.TestCase):
    def test_sum(self):
        self.assertEqual(order_total([("10.00", 2), ("5.50", 1)]), "25.50")

    def test_discount(self):
        self.assertEqual(order_total([("10.00", 3)], "SAVE10"), "27.00")

    def test_unknown_code(self):
        self.assertEqual(order_total([("10.00", 1)], "NOPE"), "10.00")

    def test_half_up(self):
        result = order_total([("0.25", 1)], "HALF")
        self.assertEqual(result, order_total([("0.25", 1)], "HALF"))

    def test_rounding_once(self):
        lines = [("0.05", 1), ("0.05", 1)]
        self.assertEqual(order_total(lines, "HALF"), order_total(list(lines), "HALF"))
