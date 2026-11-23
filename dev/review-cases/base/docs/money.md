# Money

Every amount is a `decimal.Decimal`, never a float.

Order totals follow the shop's accounting rules:
- the discount applies to the sum of the lines, not to each line;
- round once, on the final total, to the cent: never round a line or the subtotal;
- rounding is half up (0.125 becomes 0.13), not the banker's rounding of
  `round()` or of the legacy `shop.util.money.round_money`.

Reports keep the legacy helper until their figures are reconciled.
