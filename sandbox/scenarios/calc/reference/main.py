"""Command line of the reference calculator (sandbox scenario "calc")."""

import sys

from evaluator import evaluate, format_value
from lexer import CalcError


def run_one(statement):
    try:
        value, _ = evaluate(statement, {})
    except CalcError as error:
        print(error, file=sys.stderr)
        return 1
    print(format_value(value))
    return 0


def run_script(lines):
    variables = {}
    failed = False
    for line in lines:
        line = line.rstrip("\r\n")
        if not line.strip():
            continue
        try:
            value, assigned = evaluate(line, variables)
        except CalcError as error:
            print(error, file=sys.stderr)
            failed = True
            continue
        if not assigned:
            print(format_value(value))
    return 1 if failed else 0


def main(argv):
    if len(argv) == 2 and argv[0] == "-e":
        return run_one(argv[1])
    if not argv:
        return run_script(sys.stdin)
    print('usage: python main.py [-e "STATEMENT"]', file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
