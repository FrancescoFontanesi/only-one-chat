"""Sales reports."""
from shop.util.money import round_money

def daily_total(amounts):
    return round_money(sum(amounts))
