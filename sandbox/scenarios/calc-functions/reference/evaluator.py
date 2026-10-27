"""Parser and evaluator of the reference calculator with user-defined
functions (sandbox scenario "calc-functions").

A statement is parsed into a small tree, then evaluated, so that a function
body can be kept and evaluated again at each call. Precedence as in "calc":
+ -, then * / %, then unary minus, then ^ (right associative).
"""

import math

from lexer import CalcError, tokenize


def _sqrt(args):
    if args[0] < 0:
        raise CalcError("invalid argument for sqrt")
    return math.sqrt(args[0])


# name -> (minimum arguments, maximum arguments or None, implementation)
BUILTINS = {
    "sqrt": (1, 1, _sqrt),
    "abs": (1, 1, lambda args: abs(args[0])),
    "min": (1, None, min),
    "max": (1, None, max),
}

KEYWORD = "def"


class Parser:
    def __init__(self, line):
        self.tokens = tokenize(line)
        self.position = 0

    def peek(self):
        return self.tokens[self.position]

    def advance(self):
        token = self.tokens[self.position]
        self.position += 1
        return token

    def expect(self, kind, description):
        token = self.peek()
        if token.kind != kind or token.text == KEYWORD:
            raise CalcError(f"expected {description}", token.column)
        return self.advance()

    def statement(self):
        first, second = self.tokens[0], self.tokens[1]
        if first.kind == "NAME" and first.text == KEYWORD:
            return self.definition()
        if first.kind == "NAME" and second.kind == "EQUALS":
            self.position = 2
            node = self.expression()
            self.expect("END", "end of input")
            return ("assign", first.text, node)
        node = self.expression()
        self.expect("END", "end of input")
        return ("expression", node)

    def definition(self):
        self.advance()
        name = self.expect("NAME", "a function name").text
        self.expect("LPAREN", "'('")
        params = []
        if self.peek().kind != "RPAREN":
            params.append(self.expect("NAME", "a parameter name").text)
            while self.peek().kind == "COMMA":
                self.advance()
                params.append(self.expect("NAME", "a parameter name").text)
        self.expect("RPAREN", "')'")
        self.expect("EQUALS", "'='")
        body = self.expression()
        self.expect("END", "end of input")
        return ("define", name, params, body)

    def expression(self):
        node = self.term()
        while self.peek().kind == "OP" and self.peek().text in "+-":
            node = ("binary", self.advance().text, node, self.term())
        return node

    def term(self):
        node = self.unary()
        while self.peek().kind == "OP" and self.peek().text in "*/%":
            node = ("binary", self.advance().text, node, self.unary())
        return node

    def unary(self):
        if self.peek().kind == "OP" and self.peek().text == "-":
            self.advance()
            return ("negate", self.unary())
        return self.power()

    def power(self):
        base = self.primary()
        if self.peek().kind == "OP" and self.peek().text == "^":
            self.advance()
            return ("power", base, self.unary())
        return base

    def primary(self):
        token = self.peek()
        if token.kind == "NUMBER":
            self.advance()
            return ("number", float(token.text) if "." in token.text else int(token.text))
        if token.kind == "NAME" and token.text != KEYWORD:
            self.advance()
            if self.peek().kind == "LPAREN":
                return self.call(token.text)
            return ("variable", token.text)
        if token.kind == "LPAREN":
            self.advance()
            node = self.expression()
            self.expect("RPAREN", "')'")
            return node
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
        return ("call", name, args)


class Calculator:
    """Variables and user functions that last across statements."""

    def __init__(self):
        self.variables = {}
        self.functions = {}
        self.running = set()

    def run(self, line):
        """Runs one statement; returns (value, kind), kind being
        "expression", "assignment" or "definition" (value None)."""
        tree = Parser(line).statement()
        if tree[0] == "define":
            _, name, params, body = tree
            if name in BUILTINS:
                raise CalcError(f"cannot redefine built-in function '{name}'")
            seen = set()
            for param in params:
                if param in seen:
                    raise CalcError(f"duplicate parameter '{param}'")
                seen.add(param)
            self.functions[name] = (params, body)
            return None, "definition"
        if tree[0] == "assign":
            value = self.value(tree[2], self.variables)
            self.variables[tree[1]] = value
            return value, "assignment"
        return self.value(tree[1], self.variables), "expression"

    def value(self, node, scope):
        kind = node[0]
        if kind == "number":
            return node[1]
        if kind == "variable":
            if node[1] not in scope:
                raise CalcError(f"unknown variable '{node[1]}'")
            return scope[node[1]]
        if kind == "negate":
            return -self.value(node[1], scope)
        if kind == "binary":
            _, operator, left, right = node
            a, b = self.value(left, scope), self.value(right, scope)
            if operator in "/%" and b == 0:
                raise CalcError("division by zero")
            if operator == "+":
                return a + b
            if operator == "-":
                return a - b
            if operator == "*":
                return a * b
            return a / b if operator == "/" else a % b
        if kind == "power":
            base, exponent = self.value(node[1], scope), self.value(node[2], scope)
            try:
                result = base**exponent
            except ZeroDivisionError:
                raise CalcError("division by zero") from None
            if isinstance(result, complex):
                raise CalcError("invalid argument for ^")
            return result
        return self.call(node[1], [self.value(arg, scope) for arg in node[2]])

    def call(self, name, args):
        if name in BUILTINS:
            least, most, implementation = BUILTINS[name]
            if len(args) < least or (most is not None and len(args) > most):
                raise CalcError(f"wrong number of arguments for {name}")
            return implementation(args)
        if name not in self.functions:
            raise CalcError(f"unknown function '{name}'")
        params, body = self.functions[name]
        if len(args) != len(params):
            raise CalcError(f"wrong number of arguments for {name}")
        # Without conditions in the language, a call that reaches itself never ends.
        if name in self.running:
            raise CalcError("recursion is not supported")
        self.running.add(name)
        try:
            return self.value(body, {**self.variables, **dict(zip(params, args))})
        finally:
            self.running.discard(name)


def format_value(value):
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if value == 0:
        return "0"
    return repr(value) if isinstance(value, float) else str(value)
