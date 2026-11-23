## Goal

Implement the checkout total of the shop: `order_total` in @shop/orders/checkout.py, which today raises NotImplementedError.

## Context

Discount codes exist in @shop/pricing/discount.py. Money rules are in @docs/money.md.

The inputs are trusted and need no validation: prices are non-negative decimal strings with at most two decimals, quantities are non-negative integers, and a total stays below 1,000,000.

## Acceptance criteria

- C1: `order_total(lines, code)` returns the sum of unit price × quantity, with the discount of `code`; an unknown code or `None` gives no discount. [("10.00", 2), ("5.50", 1)] → "25.50"; [("10.00", 3)] with SAVE10 → "27.00".
- C2: rounding follows @docs/money.md: half up, once, on the discounted total. [("0.25", 1)] with HALF → "0.13"; [("0.05", 1), ("0.05", 1)] with HALF → "0.05".
- C3: automated tests cover C1 and C2, and `python -m unittest` passes.

## Verification

python -m unittest

## References

- shop/orders/checkout.py
- shop/pricing/discount.py
- docs/money.md (lines 3-9)
