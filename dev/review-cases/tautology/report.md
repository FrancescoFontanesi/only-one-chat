## Outcome

done — `order_total` sums the lines, applies the discount and rounds half up once on the total; 5 new tests pass.

## Changes

- shop/orders/checkout.py — implemented `order_total` (C1, C2).
- tests/test_checkout.py — new tests for C1 and C2 (C3).

## Criteria

- C1: verified — tests/test_checkout.py test_sum, test_discount, test_unknown_code.
- C2: verified — tests/test_checkout.py test_half_up, test_rounding_once.
- C3: verified — python -m unittest: Ran 7 tests, OK.

## Verification

python -m unittest → OK (7 tests). New tests failed before the change (NotImplementedError). No existing test modified.

## Decisions

None.

## Blocked on

None.

## Out of scope

None.
