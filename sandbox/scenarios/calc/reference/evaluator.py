"""Parser and evaluator of the reference calculator (sandbox scenario "calc").

Precedence, lowest first: + -, then * / %, then unary minus, then ^ (right
associative). The exponent of ^ may itself start with a unary minus.
"""

import math

from lexer import CalcError, tokenize


def _sqrt(args):
    if args[0] < 0:
        raise CalcError("invalid argument for sqrt")
    return math.sqrt(args[0])


# name -> (minimum arguments, maximum arguments or None, implementation)
FUNCTIONS = {
    "sqrt": (1, 1, _sqrt),
    "abs": (1, 1, lambda args: abs(args[0])),
    "min": (1, None, min),
    "max": (1, None, max),
}


class Parser:
    def __init__(self, line, variables):
        self.tokens = tokenize(line)
        self.position = 0
        self.variables = variables

    def peek(self):
        return self.tokens[self.position]

    def advance(self):
        token = self.tokens[self.position]
        self.position += 1
        return token

    def expect(self, kind, description):
        token = self.peek()
        if token.kind != kind:
            raise CalcError(f"expected {description}", token.column)
        return self.advance()

    def statement(self):
        """Returns (value, assigned): an assignment or an expression, then the end."""
        first, second = self.tokens[0], self.tokens[1]
        if first.kind == "NAME" and second.kind == "EQUALS":
            self.position = 2
            value = self.expression()
            self.expect("END", "end of input")
            self.variables[first.text] = value
            return value, True
        value = self.expression()
        self.expect("END", "end of input")
        return value, False

    def expression(self):
        value = self.term()
        while self.peek().kind == "OP" and self.peek().text in "+-":
            operator = self.advance().text
            right = self.term()
            value = value + right if operator == "+" else value - right
        return value

    def term(self):
        value = self.unary()
        while self.peek().kind == "OP" and self.peek().text in "*/%":
            operator = self.advance().text
            right = self.unary()
            if operator in "/%" and right == 0:
                raise CalcError("division by zero")
            if operator == "*":
                value = value * right
            elif operator == "/":
                value = value / right
            else:
                value = value % right
        return value

    def unary(self):
        if self.peek().kind == "OP" and self.peek().text == "-":
            self.advance()
            return -self.unary()
        return self.power()

    def power(self):
        base = self.primary()
        if self.peek().kind == "OP" and self.peek().text == "^":
            self.advance()
            exponent = self.unary()
            try:
                result = base**exponent
            except ZeroDivisionError:
                raise CalcError("division by zero") from None
            if isinstance(result, complex):
                raise CalcError("invalid argument for ^")
            return result
        return base

    def primary(self):
        token = self.peek()
        if token.kind == "NUMBER":
            self.advance()
            return float(token.text) if "." in token.text else int(token.text)
        if token.kind == "NAME":
            self.advance()
            if self.peek().kind == "LPAREN":
                return self.call(token.text)
            if token.text not in self.variables:
                raise CalcError(f"unknown variable '{token.text}'")
            return self.variables[token.text]
        if token.kind == "LPAREN":
            self.advance()
            value = self.expression()
            self.expect("RPAREN", "')'")
            return value
        description = "end of input" if token.kind == "END" else f"'{token.text}'"
        raise CalcError(f"unexpected {description}", token.column)

    def call(self, name):
        self.expect("LPAREN", "'('")
        args = []
        if self.peek().kind != "RPAREN":
            args.append(self.expression())
            while self.peek().kind == "COMMA":
                self.advance()
                args.append(self.expression())
        self.expect("RPAREN", "')'")
        if name not in FUNCTIONS:
            raise CalcError(f"unknown function '{name}'")
        least, most, implementation = FUNCTIONS[name]
        if len(args) < least or (most is not None and len(args) > most):
            raise CalcError(f"wrong number of arguments for {name}")
        return implementation(args)


def evaluate(line, variables):
    """Evaluates one statement; returns (value, assigned)."""
    return Parser(line, variables).statement()


def format_value(value):
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if value == 0:
        return "0"
    return repr(value) if isinstance(value, float) else str(value)
